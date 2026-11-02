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

/// Models the server's push table too (token to secret), so a test can ask whether a row is left.
private actor FakeDevices: DeviceRegistering {
	struct Registration: Equatable {
		var token: String
		var environment: PushEnvironment
		var platform: DevicePlatform
		var version: String?
		var secret: String
	}
	struct SecretUnregister: Equatable {
		var token: String
		var environment: PushEnvironment
		var secret: String
	}
	var registered: [Registration] = []
	var unregistered: [String] = []
	var secretUnregistered: [SecretUnregister] = []
	/// APNs token to the secret it was registered with.
	var rows: [String: String] = [:]
	var failRegister = false
	var hangUnregister = false
	var failUnregister = false
	var routeMissing = false
	var registerDelay: Duration?

	func setFailUnregister(_ v: Bool) { failUnregister = v }
	func setFailRegister(_ v: Bool) { failRegister = v }
	func setHangUnregister(_ v: Bool) { hangUnregister = v }
	func setRouteMissing(_ v: Bool) { routeMissing = v }
	func setRegisterDelay(_ v: Duration?) { registerDelay = v }

	func register(
		token: String, environment: PushEnvironment, platform: DevicePlatform, appVersion: String?,
		unregisterSecret: String
	) async throws -> String {
		if let registerDelay { try await Task.sleep(for: registerDelay) }
		if failRegister { throw NotificationsError("boom") }
		registered.append(
			.init(
				token: token, environment: environment, platform: platform, version: appVersion,
				secret: unregisterSecret))
		rows[token] = unregisterSecret
		return "device-\(token.prefix(4))"
	}
	func unregister(deviceId: String) async throws {
		if hangUnregister { try await Task.sleep(for: .seconds(60)) }
		if failUnregister { throw NotificationsError("offline") }
		unregistered.append(deviceId)
		rows = rows.filter { "device-\($0.key.prefix(4))" != deviceId }
	}
	func unregister(token: String, environment: PushEnvironment, secret: String) async throws {
		if hangUnregister { try await Task.sleep(for: .seconds(60)) }
		if failUnregister { throw NotificationsError("offline") }
		if routeMissing { throw DeviceUnregisterRouteMissing() }
		secretUnregistered.append(.init(token: token, environment: environment, secret: secret))
		if rows[token] == secret { rows[token] = nil }
	}
}

/// Hands out secret-1, secret-2, ... so a test can tell a reused secret from a new one.
private final class Secrets: @unchecked Sendable {
	private let lock = NSLock()
	private var count = 0
	func next() -> String { lock.withLock { count += 1; return "secret-\(count)" } }
}

private final class FakeNetwork: NetworkMonitoring, @unchecked Sendable {
	private let pair = AsyncStream<Bool>.makeStream()
	var isOnline: Bool { true }
	func updates() -> AsyncStream<Bool> { pair.stream }
	func send(_ online: Bool) { pair.continuation.yield(online) }
}

private let tokenA = Data([0xDE, 0xAD, 0xBE, 0xEF] + Array(repeating: UInt8(0x01), count: 28))
private let hexA = "deadbeef" + String(repeating: "01", count: 28)
private let tokenB = Data(repeating: 0xAB, count: 32)

@MainActor
private func makeRegistrar(
	_ system: FakeSystem, _ devices: FakeDevices,
	registration: InMemoryDeviceRegistrationStore = InMemoryDeviceRegistrationStore(),
	pending: InMemoryDeviceRegistrationStore = InMemoryDeviceRegistrationStore(),
	secrets: Secrets = Secrets(), network: (any NetworkMonitoring)? = nil
) -> PushRegistrar {
	PushRegistrar(
		system: system, devices: devices, environment: .sandbox, platform: .ios, appVersion: "1.2",
		registrationStore: registration, pendingStore: pending, network: network,
		makeSecret: { secrets.next() })
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
		#expect(
			await devices.registered == [
				.init(token: hexA, environment: .sandbox, platform: .ios, version: "1.2", secret: "secret-1")
			])
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

	@Test("accepting the in-app sheet: prompt, then the OS token, then the upload")
	func sheetAcceptedSequence() async {
		let system = FakeSystem(permission: .notDetermined, grants: true)
		let devices = FakeDevices()
		let r = makeRegistrar(system, devices)
		await r.actorChanged("a1")
		#expect(system.registerCalls == 0)
		await r.requestAuthorization()
		#expect(system.registerCalls == 1)
		#expect(await devices.registered.isEmpty, "no token yet: nothing to upload")
		await r.didReceive(deviceToken: tokenA)
		#expect(await devices.registered.map(\.token) == [hexA])
		#expect(r.registration == .registered)
	}

	@Test("a failed upload is retried when the app returns to the foreground")
	func foregroundRetriesFailedUpload() async {
		let system = FakeSystem(permission: .authorized)
		let devices = FakeDevices()
		await devices.setFailRegister(true)
		let r = makeRegistrar(system, devices)
		await r.actorChanged("a1")
		await r.didReceive(deviceToken: tokenA)
		#expect(r.registration == .failed("boom"))
		await devices.setFailRegister(false)
		await r.foregrounded()
		#expect(await devices.registered.map(\.token) == [hexA])
		#expect(r.registration == .registered)
		await r.foregrounded()
		#expect(await devices.registered.count == 1, "already registered: free")
	}

	@Test("permission switched on in iOS Settings is picked up at the next foreground")
	func foregroundPicksUpSettingsGrant() async {
		let system = FakeSystem(permission: .denied)
		let devices = FakeDevices()
		let r = makeRegistrar(system, devices)
		await r.actorChanged("a1")
		await r.didReceive(deviceToken: tokenA)
		#expect(await devices.registered.isEmpty)
		system.permission = .authorized
		await r.foregrounded()
		#expect(system.registerCalls == 1)
		#expect(await devices.registered.map(\.token) == [hexA])
	}

	@Test("foregrounding while signed out registers nothing")
	func foregroundSignedOut() async {
		let system = FakeSystem(permission: .authorized)
		let devices = FakeDevices()
		let r = makeRegistrar(system, devices)
		await r.actorChanged(nil)
		await r.didReceive(deviceToken: tokenA)
		await r.foregrounded()
		#expect(system.registerCalls == 0)
		#expect(await devices.registered.isEmpty)
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
		#expect(await devices.secretUnregistered.count == 1)
		#expect(unregisteredWhenSignOutRan == ["ran"])
		#expect(r.registration == .idle)
		// Signing in again uploads afresh.
		await r.actorChanged("a1")
		#expect(await devices.registered.count == 2)
	}

	@Test("unregisters with the device secret and the raw token in the body, not by id")
	func unregistersWithSecret() async {
		let devices = FakeDevices()
		let r = makeRegistrar(FakeSystem(permission: .authorized), devices)
		await r.actorChanged("a1")
		await r.didReceive(deviceToken: tokenA)
		await r.signOut {}
		#expect(
			await devices.secretUnregistered == [.init(token: hexA, environment: .sandbox, secret: "secret-1")])
		#expect(await devices.unregistered.isEmpty)
		#expect(await devices.rows.isEmpty)
	}

	@Test("the registration is persisted before the upload, so a failed upload still knows its secret")
	func persistedBeforeUpload() async {
		let devices = FakeDevices()
		await devices.setFailRegister(true)
		let store = InMemoryDeviceRegistrationStore()
		let r = makeRegistrar(FakeSystem(permission: .authorized), devices, registration: store)
		await r.actorChanged("a1")
		await r.didReceive(deviceToken: tokenA)
		#expect(store.load() == DeviceRegistration(token: hexA, environment: .sandbox, secret: "secret-1"))
	}

	@Test("the server's device id is added to the persisted registration once known")
	func deviceIdPersisted() async {
		let store = InMemoryDeviceRegistrationStore()
		let r = makeRegistrar(FakeSystem(permission: .authorized), FakeDevices(), registration: store)
		await r.actorChanged("a1")
		await r.didReceive(deviceToken: tokenA)
		#expect(
			store.load()
				== DeviceRegistration(
					token: hexA, environment: .sandbox, secret: "secret-1", deviceId: "device-dead"))
	}

	@Test("the secret is reused across launches and replaced only when the APNs token changes")
	func secretReuse() async {
		let devices = FakeDevices()
		let store = InMemoryDeviceRegistrationStore()
		let secrets = Secrets()
		let first = makeRegistrar(
			FakeSystem(permission: .authorized), devices, registration: store, secrets: secrets)
		await first.actorChanged("a1")
		await first.didReceive(deviceToken: tokenA)
		let relaunched = makeRegistrar(
			FakeSystem(permission: .authorized), devices, registration: store, secrets: secrets)
		await relaunched.actorChanged("a1")
		await relaunched.didReceive(deviceToken: tokenA)
		await relaunched.didReceive(deviceToken: tokenB)
		#expect(await devices.registered.map(\.secret) == ["secret-1", "secret-1", "secret-2"])
	}

	@Test("the registration survives a relaunch: signing out before any upload still unregisters")
	func signOutAfterRelaunchBeforeUpload() async {
		let devices = FakeDevices()
		let store = InMemoryDeviceRegistrationStore()
		let first = makeRegistrar(FakeSystem(permission: .authorized), devices, registration: store)
		await first.actorChanged("a1")
		await first.didReceive(deviceToken: tokenA)
		#expect(await devices.rows[hexA] == "secret-1")
		// A new process on the same store, signed out again before its token upload ran.
		let relaunched = makeRegistrar(FakeSystem(permission: .authorized), devices, registration: store)
		await relaunched.actorChanged("a1")
		await relaunched.signOut {}
		#expect(
			await devices.secretUnregistered == [.init(token: hexA, environment: .sandbox, secret: "secret-1")])
		#expect(await devices.rows.isEmpty)
	}

	@Test("sign-out during an in-flight upload still ends with the row removed")
	func signOutDuringUpload() async {
		let devices = FakeDevices()
		await devices.setRegisterDelay(.milliseconds(300))
		let pending = InMemoryDeviceRegistrationStore()
		let r = makeRegistrar(FakeSystem(permission: .authorized), devices, pending: pending)
		await r.actorChanged("a1")
		let upload = Task { await r.didReceive(deviceToken: tokenA) }
		try? await Task.sleep(for: .milliseconds(50))
		await r.signOut {}
		#expect(await devices.rows.isEmpty, "nothing on the server yet")
		#expect(pending.load() != nil, "the row may still appear, so the unregister stays owed")
		await upload.value
		#expect(await devices.registered.count == 1, "the upload did land")
		#expect(await devices.rows.isEmpty, "and was removed again once it did")
		#expect(pending.load() == nil)
	}

	@Test("a failed unregister is persisted with its secret, and survives for the next launch")
	func failedUnregisterPersists() async {
		let devices = FakeDevices()
		await devices.setFailUnregister(true)
		let pending = InMemoryDeviceRegistrationStore()
		let r = makeRegistrar(FakeSystem(permission: .authorized), devices, pending: pending)
		await r.actorChanged("a1")
		await r.didReceive(deviceToken: tokenA)
		await r.signOut {}
		#expect(
			pending.load()
				== DeviceRegistration(
					token: hexA, environment: .sandbox, secret: "secret-1", deviceId: "device-dead"))
	}

	@Test("a timed-out unregister is also persisted")
	func timedOutUnregisterPersists() async {
		let devices = FakeDevices()
		let pending = InMemoryDeviceRegistrationStore()
		let r = makeRegistrar(FakeSystem(permission: .authorized), devices, pending: pending)
		await r.actorChanged("a1")
		await r.didReceive(deviceToken: tokenA)
		await devices.setHangUnregister(true)
		await r.signOut(timeout: .milliseconds(50)) {}
		#expect(pending.load()?.secret == "secret-1")
	}

	@Test("a successful unregister leaves nothing pending")
	func successClearsPending() async {
		let pending = InMemoryDeviceRegistrationStore()
		let r = makeRegistrar(FakeSystem(permission: .authorized), FakeDevices(), pending: pending)
		await r.actorChanged("a1")
		await r.didReceive(deviceToken: tokenA)
		await r.signOut {}
		#expect(pending.load() == nil)
	}

	@Test("a failed unregister is retried at the next launch with nobody signed in")
	func retriedSignedOutAfterRelaunch() async {
		let devices = FakeDevices()
		await devices.setFailUnregister(true)
		let registration = InMemoryDeviceRegistrationStore()
		let pending = InMemoryDeviceRegistrationStore()
		let first = makeRegistrar(
			FakeSystem(permission: .authorized), devices, registration: registration, pending: pending)
		await first.actorChanged("a1")
		await first.didReceive(deviceToken: tokenA)
		await first.signOut {}
		#expect(pending.load() != nil)
		#expect(await devices.rows[hexA] == "secret-1", "still on the server: the old account would get pushes")
		// Relaunch, network is back, still nobody signed in.
		await devices.setFailUnregister(false)
		let relaunched = makeRegistrar(
			FakeSystem(permission: .authorized), devices, registration: registration, pending: pending)
		await relaunched.actorChanged(nil)
		#expect(
			await devices.secretUnregistered == [.init(token: hexA, environment: .sandbox, secret: "secret-1")])
		#expect(await devices.rows.isEmpty)
		#expect(pending.load() == nil)
	}

	@Test("the same running app retries on foreground even though its token is unchanged")
	func retriedOnForegroundSameToken() async {
		let devices = FakeDevices()
		await devices.setFailUnregister(true)
		let pending = InMemoryDeviceRegistrationStore()
		let r = makeRegistrar(FakeSystem(permission: .authorized), devices, pending: pending)
		await r.actorChanged("a1")
		await r.didReceive(deviceToken: tokenA)
		await r.signOut {}
		await r.foregrounded()
		#expect(pending.load() != nil, "still offline: stays pending")
		await devices.setFailUnregister(false)
		await r.foregrounded()
		#expect(await devices.rows.isEmpty)
		#expect(pending.load() == nil)
	}

	@Test("the network coming back finishes a pending unregister, with nobody signed in")
	func retriedWhenNetworkReturns() async {
		let devices = FakeDevices()
		let pending = InMemoryDeviceRegistrationStore(
			DeviceRegistration(token: hexA, environment: .sandbox, secret: "secret-1", deviceId: "device-dead"))
		let network = FakeNetwork()
		let r = makeRegistrar(FakeSystem(permission: .authorized), devices, pending: pending, network: network)
		network.send(false)
		network.send(true)
		for _ in 0..<200 where pending.load() != nil { try? await Task.sleep(for: .milliseconds(10)) }
		#expect(pending.load() == nil)
		#expect(await devices.secretUnregistered.count == 1)
		_ = r
	}

	@Test("an old server (route missing) keeps the pending record when nobody is signed in")
	func routeMissingKeepsPending() async {
		let devices = FakeDevices()
		await devices.setRouteMissing(true)
		let pending = InMemoryDeviceRegistrationStore(
			DeviceRegistration(token: hexA, environment: .sandbox, secret: "secret-1", deviceId: "device-dead"))
		let r = makeRegistrar(FakeSystem(permission: .authorized), devices, pending: pending)
		await r.actorChanged(nil)
		#expect(pending.load() != nil)
		#expect(await devices.unregistered.isEmpty, "no credentials to fall back on")
	}

	@Test("an old server falls back to the authenticated delete at sign-out, while still signed in")
	func routeMissingFallsBackWhileSignedIn() async {
		let devices = FakeDevices()
		await devices.setRouteMissing(true)
		let pending = InMemoryDeviceRegistrationStore()
		let r = makeRegistrar(FakeSystem(permission: .authorized), devices, pending: pending)
		await r.actorChanged("a1")
		await r.didReceive(deviceToken: tokenA)
		await r.signOut {}
		#expect(await devices.unregistered == ["device-dead"])
		#expect(pending.load() == nil)
	}

	@Test("an old server and no device id yet: sign-out keeps the record rather than calling it done")
	func routeMissingWithoutDeviceId() async {
		let devices = FakeDevices()
		await devices.setRouteMissing(true)
		let store = InMemoryDeviceRegistrationStore(
			DeviceRegistration(token: hexA, environment: .sandbox, secret: "secret-1"))
		let pending = InMemoryDeviceRegistrationStore()
		let r = makeRegistrar(
			FakeSystem(permission: .authorized), devices, registration: store, pending: pending)
		await r.actorChanged("a1")
		await r.signOut {}
		#expect(pending.load() != nil)
	}

	@Test("registering the same token again drops the pending unregister instead of undoing it")
	func reRegisterClearsPending() async {
		let devices = FakeDevices()
		let pending = InMemoryDeviceRegistrationStore(
			DeviceRegistration(token: hexA, environment: .sandbox, secret: "secret-0", deviceId: "device-dead"))
		let r = makeRegistrar(FakeSystem(permission: .authorized), devices, pending: pending)
		await r.didReceive(deviceToken: tokenA)
		await r.actorChanged("a1")
		#expect(pending.load() == nil)
		#expect(await devices.secretUnregistered.isEmpty, "the live row must not be deleted")
		#expect(await devices.registered.count == 1)
	}

	@Test("a rotated token lets whoever signs in next finish the pending unregister")
	func rotatedTokenRetries() async {
		let devices = FakeDevices()
		let pending = InMemoryDeviceRegistrationStore(
			DeviceRegistration(token: hexA, environment: .sandbox, secret: "secret-0", deviceId: "device-dead"))
		let r = makeRegistrar(FakeSystem(permission: .authorized), devices, pending: pending)
		await r.didReceive(deviceToken: tokenB)
		await r.actorChanged("a2")
		#expect(
			await devices.secretUnregistered == [.init(token: hexA, environment: .sandbox, secret: "secret-0")])
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

@Suite("DeviceRegistration")
struct DeviceRegistrationTests {
	@Test("a generated secret is url-safe, 43 characters and different every time")
	func secret() {
		let one = DeviceRegistration.generateSecret()
		let two = DeviceRegistration.generateSecret()
		#expect(one.count == 43)
		#expect(one.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
		#expect(one != two)
	}

	@Test("the Keychain-backed store round-trips a registration and clears it")
	func store() {
		let store = KeychainDeviceRegistrationStore(secrets: InMemorySecretStore())
		#expect(store.load() == nil)
		let record = DeviceRegistration(
			token: hexA, environment: .production, secret: "secret-1", deviceId: "device-dead")
		store.save(record)
		#expect(store.load() == record)
		store.save(nil)
		#expect(store.load() == nil)
	}

	@Test("an unreadable stored record is treated as none")
	func garbage() throws {
		let secrets = InMemorySecretStore()
		try secrets.write(Data("not json".utf8))
		#expect(KeychainDeviceRegistrationStore(secrets: secrets).load() == nil)
	}
}
