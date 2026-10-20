import Foundation
import Testing

@testable import MaskinCore

private final class FakeSystem: PushSystem, @unchecked Sendable {
	var permission: PushPermission
	var grants: Bool
	var promptCount = 0
	var registerCalls = 0
	var badges: [Int] = []
	init(permission: PushPermission = .notDetermined, grants: Bool = true) {
		self.permission = permission
		self.grants = grants
	}
	func currentPermission() async -> PushPermission { permission }
	func requestPermission() async -> Bool {
		promptCount += 1
		permission = grants ? .authorized : .denied
		return grants
	}
	@MainActor func registerForRemoteNotifications() { registerCalls += 1 }
	@MainActor func setBadge(_ count: Int) { badges.append(count) }
}

private actor FakeDevices: DeviceRegistering {
	struct Registration: Equatable {
		var token: String
		var environment: PushEnvironment
		var platform: DevicePlatform
		var version: String?
	}
	var registered: [Registration] = []
	var unregistered: [String] = []
	var failRegister = false
	var hangUnregister = false
	var failUnregister = false

	func setFailUnregister(_ v: Bool) { failUnregister = v }
	func setFailRegister(_ v: Bool) { failRegister = v }
	func setHangUnregister(_ v: Bool) { hangUnregister = v }

	func register(token: String, environment: PushEnvironment, platform: DevicePlatform, appVersion: String?)
		async throws -> String
	{
		if failRegister { throw NotificationsError("boom") }
		registered.append(.init(token: token, environment: environment, platform: platform, version: appVersion))
		return "device-\(token.prefix(4))"
	}
	func unregister(deviceId: String) async throws {
		if hangUnregister { try await Task.sleep(for: .seconds(60)) }
		if failUnregister { throw NotificationsError("offline") }
		unregistered.append(deviceId)
	}
}

private let tokenA = Data([0xDE, 0xAD, 0xBE, 0xEF] + Array(repeating: UInt8(0x01), count: 28))
private let hexA = "deadbeef" + String(repeating: "01", count: 28)
private let tokenB = Data(repeating: 0xAB, count: 32)

@MainActor
private func makeRegistrar(
	_ system: FakeSystem, _ devices: FakeDevices,
	pending: InMemoryPendingUnregisterStore = InMemoryPendingUnregisterStore()
) -> PushRegistrar {
	PushRegistrar(
		system: system, devices: devices, environment: .sandbox, platform: .ios, appVersion: "1.2",
		pendingStore: pending)
}

@MainActor
@Suite("PushRegistrar")
struct PushRegistrarTests {
	@Test("token is hex-encoded and uploaded with environment, platform and version")
	func uploads() async {
		let system = FakeSystem(permission: .authorized)
		let devices = FakeDevices()
		let r = makeRegistrar(system, devices)
		await r.actorChanged("a1")
		#expect(system.registerCalls == 1)
		await r.didReceive(deviceToken: tokenA)
		#expect(await devices.registered == [.init(token: hexA, environment: .sandbox, platform: .ios, version: "1.2")])
		#expect(r.registration == .registered)
	}

	@Test("never prompts on launch; prompts once when asked, then registers")
	func promptFlow() async {
		let system = FakeSystem(permission: .notDetermined, grants: true)
		let devices = FakeDevices()
		let r = makeRegistrar(system, devices)
		await r.actorChanged("a1")
		#expect(system.promptCount == 0)
		#expect(system.registerCalls == 0)
		await r.requestAuthorization()
		#expect(system.promptCount == 1)
		#expect(r.permission == .authorized)
		#expect(system.registerCalls == 1)
		await r.requestAuthorization()
		#expect(system.promptCount == 1)
	}

	@Test("denied permission uploads nothing and doesn't re-prompt")
	func denied() async {
		let system = FakeSystem(permission: .notDetermined, grants: false)
		let devices = FakeDevices()
		let r = makeRegistrar(system, devices)
		await r.actorChanged("a1")
		await r.requestAuthorization()
		await r.didReceive(deviceToken: tokenA)
		#expect(r.permission == .denied)
		#expect(system.registerCalls == 0)
		#expect(await devices.registered.isEmpty)
		await r.requestAuthorization()
		#expect(system.promptCount == 1)
	}

	@Test("an identical token for the same actor is uploaded once")
	func dedupes() async {
		let system = FakeSystem(permission: .authorized)
		let devices = FakeDevices()
		let r = makeRegistrar(system, devices)
		await r.actorChanged("a1")
		await r.didReceive(deviceToken: tokenA)
		await r.didReceive(deviceToken: tokenA)
		await r.actorChanged("a1")
		#expect(await devices.registered.count == 1)
	}

	@Test("a rotated token is uploaded again")
	func tokenChange() async {
		let system = FakeSystem(permission: .authorized)
		let devices = FakeDevices()
		let r = makeRegistrar(system, devices)
		await r.actorChanged("a1")
		await r.didReceive(deviceToken: tokenA)
		await r.didReceive(deviceToken: tokenB)
		#expect(await devices.registered.map(\.token) == [hexA, tokenB.pushTokenHex])
	}

	@Test("a different signed-in actor re-registers the same token")
	func actorChange() async {
		let system = FakeSystem(permission: .authorized)
		let devices = FakeDevices()
		let r = makeRegistrar(system, devices)
		await r.actorChanged("a1")
		await r.didReceive(deviceToken: tokenA)
		await r.actorChanged("a2")
		#expect(await devices.registered.count == 2)
	}

	@Test("a token that arrives before sign-in is uploaded after it")
	func tokenBeforeSignIn() async {
		let system = FakeSystem(permission: .authorized)
		let devices = FakeDevices()
		let r = makeRegistrar(system, devices)
		await r.actorChanged(nil)
		await r.didReceive(deviceToken: tokenA)
		#expect(await devices.registered.isEmpty)
		await r.actorChanged("a1")
		#expect(await devices.registered.count == 1)
	}

	@Test("sign-out unregisters the token before credentials are cleared")
	func signOutOrder() async {
		let system = FakeSystem(permission: .authorized)
		let devices = FakeDevices()
		let r = makeRegistrar(system, devices)
		await r.actorChanged("a1")
		await r.didReceive(deviceToken: tokenA)
		var unregisteredWhenSignOutRan: [String] = []
		await r.signOut {
			unregisteredWhenSignOutRan = ["ran"]
		}
		#expect(await devices.unregistered == ["device-dead"])
		#expect(unregisteredWhenSignOutRan == ["ran"])
		#expect(r.registration == .idle)
		// Signing in again uploads afresh.
		await r.actorChanged("a1")
		#expect(await devices.registered.count == 2)
	}

	@Test("unregisters by the server's device id, never by the raw token")
	func unregistersById() async {
		let devices = FakeDevices()
		let r = makeRegistrar(FakeSystem(permission: .authorized), devices)
		await r.actorChanged("a1")
		await r.didReceive(deviceToken: tokenA)
		await r.signOut {}
		let sent = await devices.unregistered
		#expect(sent.count == 1)
		#expect(!sent[0].contains(hexA))
		#expect(sent[0].hasPrefix("device-"))
	}

	@Test("a failed unregister is persisted, and survives for the next launch")
	func failedUnregisterPersists() async {
		let devices = FakeDevices()
		await devices.setFailUnregister(true)
		let pending = InMemoryPendingUnregisterStore()
		let r = makeRegistrar(FakeSystem(permission: .authorized), devices, pending: pending)
		await r.actorChanged("a1")
		await r.didReceive(deviceToken: tokenA)
		await r.signOut {}
		#expect(pending.load() == PendingUnregister(deviceId: "device-dead", token: hexA, actorId: "a1"))
	}

	@Test("a timed-out unregister is also persisted")
	func timedOutUnregisterPersists() async {
		let devices = FakeDevices()
		let pending = InMemoryPendingUnregisterStore()
		let r = makeRegistrar(FakeSystem(permission: .authorized), devices, pending: pending)
		await r.actorChanged("a1")
		await r.didReceive(deviceToken: tokenA)
		await devices.setHangUnregister(true)
		await r.signOut(timeout: .milliseconds(50)) {}
		#expect(pending.load()?.actorId == "a1")
	}

	@Test("a successful unregister leaves nothing pending")
	func successClearsPending() async {
		let pending = InMemoryPendingUnregisterStore()
		let r = makeRegistrar(FakeSystem(permission: .authorized), FakeDevices(), pending: pending)
		await r.actorChanged("a1")
		await r.didReceive(deviceToken: tokenA)
		await r.signOut {}
		#expect(pending.load() == nil)
	}

	@Test("registering the same token again drops the pending unregister instead of undoing it")
	func reRegisterClearsPending() async {
		let devices = FakeDevices()
		let pending = InMemoryPendingUnregisterStore(
			PendingUnregister(deviceId: "device-dead", token: hexA, actorId: "a1"))
		let r = makeRegistrar(FakeSystem(permission: .authorized), devices, pending: pending)
		await r.didReceive(deviceToken: tokenA)
		await r.actorChanged("a1")
		#expect(pending.load() == nil)
		#expect(await devices.unregistered.isEmpty, "the live row must not be deleted")
		#expect(await devices.registered.count == 1)
	}

	@Test("a rotated token lets the owner finish the pending unregister")
	func rotatedTokenRetries() async {
		let devices = FakeDevices()
		let pending = InMemoryPendingUnregisterStore(
			PendingUnregister(deviceId: "device-old", token: hexA, actorId: "a1"))
		let r = makeRegistrar(FakeSystem(permission: .authorized), devices, pending: pending)
		await r.didReceive(deviceToken: tokenB)
		await r.actorChanged("a1")
		#expect(await devices.unregistered == ["device-old"])
		#expect(pending.load() == nil)
	}

	@Test("another actor drops the pending unregister: only the owner could delete that row")
	func otherActorDropsPending() async {
		let devices = FakeDevices()
		let pending = InMemoryPendingUnregisterStore(
			PendingUnregister(deviceId: "device-old", token: hexA, actorId: "a1"))
		let r = makeRegistrar(FakeSystem(permission: .authorized), devices, pending: pending)
		await r.didReceive(deviceToken: tokenB)
		await r.actorChanged("a2")
		#expect(await devices.unregistered.isEmpty)
		#expect(pending.load() == nil)
	}

	@Test("sign-out still completes when unregistering hangs")
	func signOutTimeout() async {
		let system = FakeSystem(permission: .authorized)
		let devices = FakeDevices()
		let r = makeRegistrar(system, devices)
		await r.actorChanged("a1")
		await r.didReceive(deviceToken: tokenA)
		await devices.setHangUnregister(true)
		var ran = false
		await r.signOut(timeout: .milliseconds(50)) { ran = true }
		#expect(ran)
	}

	@Test("sign-out without a registered token just signs out")
	func signOutNothingRegistered() async {
		let r = makeRegistrar(FakeSystem(permission: .denied), FakeDevices())
		var ran = false
		await r.signOut { ran = true }
		#expect(ran)
	}

	@Test("an upload failure is surfaced and retried on the next sync")
	func failureRetries() async {
		let system = FakeSystem(permission: .authorized)
		let devices = FakeDevices()
		await devices.setFailRegister(true)
		let r = makeRegistrar(system, devices)
		await r.actorChanged("a1")
		await r.didReceive(deviceToken: tokenA)
		if case .failed = r.registration {} else { Issue.record("expected failed") }
		await devices.setFailRegister(false)
		await r.actorChanged("a1")
		#expect(r.registration == .registered)
		#expect(await devices.registered.count == 1)
	}

	@Test("OS registration failure is reported")
	func osFailure() {
		let r = makeRegistrar(FakeSystem(), FakeDevices())
		r.didFailToRegister(NotificationsError("no network"))
		if case .failed = r.registration {} else { Issue.record("expected failed") }
	}

	@Test("badge is clamped at zero")
	func badge() {
		let system = FakeSystem()
		let r = makeRegistrar(system, FakeDevices())
		r.setBadge(3)
		r.setBadge(-2)
		#expect(system.badges == [3, 0])
	}
}

@Suite("PushEnvironment")
struct PushEnvironmentTests {
	@Test("reads aps-environment out of a provisioning profile")
	func parse() {
		func profile(_ value: String) -> Data {
			Data("junk\u{0}<dict><key>aps-environment</key>\n\t<string>\(value)</string></dict>".utf8)
		}
		#expect(PushEnvironment.parse(provisioningProfile: profile("development")) == .sandbox)
		#expect(PushEnvironment.parse(provisioningProfile: profile("production")) == .production)
		#expect(PushEnvironment.parse(provisioningProfile: Data("no entitlement".utf8)) == nil)
		#expect(PushEnvironment.parse(provisioningProfile: profile("bogus")) == nil)
	}

	@Test("hex encoding is lowercase and zero-padded")
	func hex() {
		#expect(Data([0x00, 0x0A, 0xFF]).pushTokenHex == "000aff")
	}
}
