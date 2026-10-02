import Foundation
import MaskinCore
import Testing

@testable import MaskinFeatures

// MARK: - Fakes

private struct StubSource: NotificationsSource {
	var rows: [AppNotification] = []
	func list() async throws -> [AppNotification] { rows }
	func setStatus(id: String, status: AppNotification.Status) async throws -> AppNotification {
		throw NotificationsError("unused")
	}
	func delete(id: String) async throws {}
	func respond(id: String, response: JSONValue) async throws -> AppNotification {
		throw NotificationsError("unused")
	}
	func actors(ids: [String]) async throws -> [NotificationActor] { [] }
}

private final class FakeSystem: PushSystem, @unchecked Sendable {
	var badges: [Int] = []
	var permission: PushPermission = .authorized
	var promptCount = 0
	func currentPermission() async -> PushPermission { permission }
	func requestPermission() async -> Bool {
		promptCount += 1
		permission = .authorized
		return true
	}
	@MainActor func registerForRemoteNotifications() {}
	@MainActor func setBadge(_ count: Int) { badges.append(count) }
}

/// Records what the credentials looked like when the token was unregistered.
private final class FakeDevices: DeviceRegistering, @unchecked Sendable {
	private let lock = NSLock()
	private var _unregistered: [Bool] = []
	var hang = false
	let signedIn: @Sendable () async -> Bool

	init(signedIn: @escaping @Sendable () async -> Bool) { self.signedIn = signedIn }

	var unregisteredWhileSignedIn: [Bool] { lock.withLock { _unregistered } }

	func register(
		token: String, environment: PushEnvironment, platform: DevicePlatform, appVersion: String?
	) async throws -> String { "device-1" }

	func unregister(deviceId: String) async throws {
		if hang { try await Task.sleep(for: .seconds(60)) }
		let was = await signedIn()
		lock.withLock { _unregistered.append(was) }
	}
}

private func unread(_ id: String) -> AppNotification {
	AppNotification(id: id, workspaceId: "ws-1", kind: .alert, title: "T", sourceActorId: "a")
}

@MainActor
private func makeRuntime(
	signedIn: Bool = true, push: PushRegistrar? = nil, rows: [AppNotification] = []
) async -> (AppRuntime, AppEnvironment) {
	let environment = AppEnvironment.preview(signedIn: signedIn)
	await environment.workspaces.refresh()
	let store = NotificationsStore(
		source: StubSource(rows: rows), currentActorId: { environment.auth.session?.actorId })
	return (AppRuntime(environment: environment, push: push, notifications: store), environment)
}

// MARK: - Deep links

@MainActor
@Suite("AppRuntime deep links")
struct AppRuntimeDeepLinkTests {
	@Test("an object link in the current workspace opens that object")
	func objectLink() async {
		let (runtime, environment) = await makeRuntime()
		#expect(runtime.open(URL(string: "maskin://ws-1/objects/obj-9")!))
		#expect(runtime.presentedObject == .init(id: "obj-9"))
		#expect(environment.workspaceId == "ws-1")
	}

	@Test("a chat link selects Chats and requests that thread")
	func chatLink() async {
		let (runtime, _) = await makeRuntime()
		runtime.openObject("stale")
		runtime.open(URL(string: "maskin://ws-1/chats/chat-4")!)
		#expect(runtime.selectedTab == .chats)
		#expect(runtime.requestedConversationId == "chat-4")
		#expect(runtime.presentedObject == nil)
	}

	@Test("a notifications link opens the inbox")
	func inboxLink() async {
		let (runtime, _) = await makeRuntime()
		runtime.open(URL(string: "maskin://ws-1/notifications")!)
		#expect(runtime.showNotifications)
	}

	@Test("a link into another workspace you belong to switches first, then opens")
	func crossWorkspace() async {
		let (runtime, environment) = await makeRuntime()
		runtime.open(URL(string: "https://maskin.io/ws-2/objects/obj-1")!)
		#expect(environment.workspaceId == "ws-2")
		#expect(runtime.presentedObject == .init(id: "obj-1"))
	}

	@Test("a link into a workspace you are not in is refused and changes nothing")
	func nonMember() async {
		let (runtime, environment) = await makeRuntime()
		runtime.open(URL(string: "maskin://ws-other/objects/obj-1")!)
		#expect(runtime.presentedObject == nil)
		#expect(environment.workspaceId == "ws-1")
		#expect(runtime.router.rejection == .notAMember(workspaceId: "ws-other"))
		#expect(runtime.rejectionMessage != nil)
	}

	@Test(
		"malformed or foreign links are not opened",
		arguments: [
			"https://evil.example/ws-1/objects/obj-1",
			"maskin://ws-1/objects/../secret",
			"maskin://ws-1/objects/a%2Fb",
			"maskin://ws-1/unknown/obj-1",
			"maskin://ws-1/objects/obj-1/extra",
			"javascript:alert(1)",
		])
	func malformed(raw: String) async {
		let (runtime, environment) = await makeRuntime()
		let accepted = runtime.open(URL(string: raw)!)
		#expect(!accepted)
		#expect(runtime.presentedObject == nil)
		#expect(runtime.requestedConversationId == nil)
		#expect(!runtime.showNotifications)
		#expect(environment.workspaceId == "ws-1")
		#expect(runtime.router.rejection == .unrecognized)
	}

	@Test("a link that arrives before the workspace list loads waits for it")
	func heldUntilWorkspacesLoad() async {
		let environment = AppEnvironment.preview()
		let runtime = AppRuntime(
			environment: environment,
			notifications: NotificationsStore(source: StubSource(), currentActorId: { nil }))
		runtime.open(URL(string: "maskin://ws-2/objects/obj-1")!)
		#expect(runtime.presentedObject == nil)

		await environment.workspaces.refresh()
		runtime.sync()

		#expect(environment.workspaceId == "ws-2")
		#expect(runtime.presentedObject == .init(id: "obj-1"))
	}
}

// MARK: - Badge

@MainActor
@Suite("AppRuntime badge")
struct AppRuntimeBadgeTests {
	@Test("the app icon badge mirrors the unread count")
	func badge() async {
		let system = FakeSystem()
		let devices = FakeDevices { true }
		let push = PushRegistrar(
			system: system, devices: devices, environment: .sandbox, platform: .ios,
			pendingStore: InMemoryPendingUnregisterStore())
		let (runtime, _) = await makeRuntime(push: push, rows: [unread("1"), unread("2")])
		await runtime.notifications.reload()
		runtime.updateBadge()
		#expect(system.badges.last == 2)
		#expect(runtime.notifications.unreadCount == 2)
	}
}

// MARK: - Push permission

@MainActor
@Suite("AppRuntime push permission")
struct AppRuntimePushPermissionTests {
	@Test("signing in does not prompt; opening the inbox does")
	func promptDeferredToInbox() async {
		let system = FakeSystem()
		system.permission = .notDetermined
		let push = PushRegistrar(
			system: system, devices: FakeDevices { true }, environment: .sandbox, platform: .ios,
			pendingStore: InMemoryPendingUnregisterStore())
		let (runtime, _) = await makeRuntime(push: push)

		await runtime.actorChanged("actor-1")
		#expect(system.promptCount == 0, "no prompt just because the user signed in")

		await runtime.requestPushPermission()
		#expect(system.promptCount == 1)
	}
}

// MARK: - Sign-out

@MainActor
@Suite("AppRuntime sign-out")
struct AppRuntimeSignOutTests {
	private func tempDirectory() -> URL {
		FileManager.default.temporaryDirectory
			.appendingPathComponent("app-runtime-\(UUID().uuidString)", isDirectory: true)
	}

	@Test("unregisters the push token before credentials are cleared, then cleans up")
	func orderingAndCleanup() async throws {
		let environment = AppEnvironment.preview()
		await environment.workspaces.refresh()
		let env = environment
		let devices = FakeDevices { await MainActor.run { env.auth.session != nil } }
		let system = FakeSystem()
		let push = PushRegistrar(
			system: system, devices: devices, environment: .sandbox, platform: .ios,
			pendingStore: InMemoryPendingUnregisterStore())
		await push.actorChanged("actor-1")
		await push.didReceive(deviceToken: Data(repeating: 1, count: 32))
		let store = NotificationsStore(
			source: StubSource(rows: [unread("1")]), currentActorId: { "actor-1" })
		let dir = tempDirectory()
		let runtime = AppRuntime(
			environment: environment, push: push, notifications: store, forYouDirectory: dir)
		await store.reload()
		#expect(store.unreadCount == 1)
		runtime.open(URL(string: "maskin://ws-1/objects/o")!)
		runtime.showNotifications = true

		let queue = runtime.forYou
		try queue.outbox.enqueue(
			kind: "decision.reply", lane: "o", summary: "Reply", payload: "hi", holdFor: 3600)
		let file = dir.appendingPathComponent("outbox-actor-1.json")
		#expect(FileManager.default.fileExists(atPath: file.path))

		await runtime.signOut()

		#expect(devices.unregisteredWhileSignedIn == [true], "token unregistered while still signed in")
		#expect(environment.auth.session == nil)
		#expect(!FileManager.default.fileExists(atPath: file.path), "queued writes are deleted")
		#expect(queue.outbox.entries.isEmpty)
		#expect(store.notifications.isEmpty)
		#expect(runtime.router.pending == nil && runtime.router.incoming == nil)
		#expect(runtime.presentedObject == nil)
		#expect(!runtime.showNotifications)
		#expect(system.badges.last == 0)
		#expect(!runtime.isSigningOut)
	}

	@Test("sign-out deletes the queue file by path even when no runtime was ever built")
	func deletesQueueWithoutRuntime() async throws {
		let environment = AppEnvironment.preview()
		let dir = tempDirectory()
		try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
		let file = ForYouRuntime.outboxFileURL(actorId: "actor-1", directory: dir)
		try Data("{}".utf8).write(to: file)
		let runtime = AppRuntime(
			environment: environment,
			notifications: NotificationsStore(source: StubSource(), currentActorId: { nil }),
			forYouDirectory: dir)

		await runtime.signOut()

		#expect(!FileManager.default.fileExists(atPath: file.path))
	}

	@Test("a session ended by the server keeps the queued writes for the same actor")
	func expiryKeepsQueue() async throws {
		let environment = AppEnvironment.preview()
		let dir = tempDirectory()
		let runtime = AppRuntime(
			environment: environment,
			notifications: NotificationsStore(source: StubSource(), currentActorId: { nil }),
			forYouDirectory: dir)
		let queue = runtime.forYou
		try queue.outbox.enqueue(
			kind: "decision.reply", lane: "o", summary: "Reply", payload: "hi", holdFor: 3600)
		let file = ForYouRuntime.outboxFileURL(actorId: "actor-1", directory: dir)
		#expect(FileManager.default.fileExists(atPath: file.path))

		environment.auth.sessionRejected(apiKey: "ank_preview")
		runtime.sync()

		#expect(environment.auth.session == nil)
		#expect(environment.auth.sessionExpired)
		#expect(FileManager.default.fileExists(atPath: file.path), "expiry must not discard queued writes")
		#expect(queue.outbox.entries.count == 1)
	}

	@Test("a view reading the runtime while signed out neither retains one nor touches a queue")
	func signedOutReadIsInert() async throws {
		let environment = AppEnvironment.preview(signedIn: false)
		let dir = tempDirectory()
		let runtime = AppRuntime(
			environment: environment,
			notifications: NotificationsStore(source: StubSource(), currentActorId: { nil }),
			forYouDirectory: dir)
		let a = runtime.forYou
		let b = runtime.forYou
		#expect(a !== b, "nothing is cached for nobody")
		#expect(a.actorId == nil)
		#expect(!FileManager.default.fileExists(atPath: dir.path))
	}

	@Test("one runtime per actor: the same instance until the actor changes")
	func runtimeIsOwnedAndStable() async {
		let environment = AppEnvironment.preview()
		let runtime = AppRuntime(
			environment: environment,
			notifications: NotificationsStore(source: StubSource(), currentActorId: { nil }),
			forYouDirectory: tempDirectory())
		#expect(runtime.forYou === runtime.forYou)
	}

	@Test("a dead network cannot trap the user signed in")
	func unregisterTimeout() async {
		let environment = AppEnvironment.preview()
		let env = environment
		let devices = FakeDevices { await MainActor.run { env.auth.session != nil } }
		devices.hang = true
		let push = PushRegistrar(
			system: FakeSystem(), devices: devices, environment: .sandbox, platform: .ios,
			pendingStore: InMemoryPendingUnregisterStore())
		await push.actorChanged("actor-1")
		await push.didReceive(deviceToken: Data(repeating: 2, count: 32))
		let runtime = AppRuntime(
			environment: environment, push: push,
			notifications: NotificationsStore(source: StubSource(), currentActorId: { nil }),
			signOutTimeout: .milliseconds(50))

		await runtime.signOut()

		#expect(environment.auth.session == nil)
	}

	@Test("signing out without push still signs out")
	func withoutPush() async {
		let (runtime, environment) = await makeRuntime()
		await runtime.signOut()
		#expect(environment.auth.session == nil)
		#expect(environment.workspaces.workspaces.isEmpty)
	}
}

// MARK: - Chats entry point and decision section

@MainActor
@Suite("Shell integration helpers")
struct ShellIntegrationTests {
	@Test("a requested conversation becomes the selection and clears the request")
	func chatRequestConsumed() {
		var request: String? = "chat-1"
		var selection: String? = "other"
		#expect(ChatsScreen.consume(request: &request, into: &selection))
		#expect(selection == "chat-1")
		#expect(request == nil)
		#expect(!ChatsScreen.consume(request: &request, into: &selection))
		#expect(selection == "chat-1")
	}

	@Test("an object shows the card only when it is a decision or already acted on")
	func decisionEntrySelection() {
		func entry(_ id: String, _ bucket: FeedBucket) -> FeedEntry {
			FeedEntry(
				card: ForYouCard(id: id, objectType: "bet"), bucket: bucket)
		}
		let entries = [entry("a", .needs), entry("b", .fyi), entry("c", .done)]
		#expect(ObjectDecisionSection.entry(for: "a", in: entries)?.id == "a")
		#expect(ObjectDecisionSection.entry(for: "b", in: entries) == nil)
		#expect(ObjectDecisionSection.entry(for: "c", in: entries)?.id == "c")
		#expect(ObjectDecisionSection.entry(for: "zzz", in: entries) == nil)
	}
}
