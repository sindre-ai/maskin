import Foundation
import MaskinCore
import Testing

@testable import MaskinFeatures

// MARK: - Fakes

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

@MainActor
private func makeRuntime(
	signedIn: Bool = true, push: PushRegistrar? = nil
) async -> (AppRuntime, AppEnvironment) {
	let environment = AppEnvironment.preview(signedIn: signedIn)
	await environment.workspaces.refresh()
	return (AppRuntime(environment: environment, push: push), environment)
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

	@Test("a notifications link lands on For You")
	func inboxLink() async {
		let (runtime, _) = await makeRuntime()
		runtime.selectedTab = .chats
		runtime.open(URL(string: "maskin://ws-1/notifications")!)
		#expect(runtime.selectedTab == .forYou)
		#expect(runtime.presentation == nil)
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
		#expect(environment.workspaceId == "ws-1")
		#expect(runtime.router.rejection == .unrecognized)
	}

	@Test("a link that arrives before the workspace list loads waits for it")
	func heldUntilWorkspacesLoad() async {
		let environment = AppEnvironment.preview()
		let runtime = AppRuntime(environment: environment)
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
	@Test("the app icon carries no badge")
	func badge() async {
		let system = FakeSystem()
		let devices = FakeDevices { true }
		let push = PushRegistrar(
			system: system, devices: devices, environment: .sandbox, platform: .ios,
			pendingStore: InMemoryPendingUnregisterStore())
		let (runtime, _) = await makeRuntime(push: push)
		runtime.updateBadge()
		#expect(system.badges.last == 0)
	}
}

// MARK: - Push permission

@MainActor
@Suite("AppRuntime push permission")
struct AppRuntimePushPermissionTests {
	@Test("signing in does not prompt; opening Chats does")
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
		let dir = tempDirectory()
		let runtime = AppRuntime(
			environment: environment, push: push, forYouDirectory: dir)
		runtime.open(URL(string: "maskin://ws-1/objects/o")!)
		runtime.presentation = .settings

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
		#expect(runtime.router.pending == nil && runtime.router.incoming == nil)
		#expect(runtime.presentedObject == nil)
		#expect(runtime.presentation == nil)
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

	@Test("after a 401: queue held; same actor signing in resumes it, a different actor loses it")
	func expiryThenRelogin() async throws {
		struct Login: Authenticating {
			let result: LoginResult
			func login(email: String, password: String) async throws -> LoginResult { result }
		}
		func result(_ actor: String) -> LoginResult {
			LoginResult(apiKey: "key-\(actor)", actorId: actor, name: actor, email: nil, workspaceId: "ws-1")
		}
		for (relogin, survives) in [("actor-1", true), ("actor-2", false)] {
			let dir = tempDirectory()
			let secrets = InMemorySecretStore()
			let auth = AuthSession(authenticator: Login(result: result("actor-1")), store: secrets)
			await auth.signIn(email: "a", password: "b")
			let preview = AppEnvironment.preview()
			let environment = AppEnvironment(
				baseURL: preview.baseURL, clientSource: "test", auth: auth,
				workspaces: WorkspaceStore(source: StaticWorkspaceSource([]), auth: auth),
				client: preview.client, events: EventHub(client: nil))
			let runtime = AppRuntime(environment: environment, forYouDirectory: dir)
			try runtime.forYou.outbox.enqueue(
				kind: "decision.reply", lane: "o", summary: "Reply", payload: "hi", holdFor: 3600)
			let file = ForYouRuntime.outboxFileURL(actorId: "actor-1", directory: dir)

			// The server rejects the key (what the request middleware / event stream report).
			auth.sessionRejected(apiKey: "key-actor-1")
			runtime.sync()
			#expect(auth.session == nil)
			#expect(FileManager.default.fileExists(atPath: file.path), "held, not dropped")

			// Sign in again.
			let again = AuthSession(authenticator: Login(result: result(relogin)), store: secrets)
			await again.signIn(email: "a", password: "b")
			let env2 = AppEnvironment(
				baseURL: preview.baseURL, clientSource: "test", auth: again,
				workspaces: WorkspaceStore(source: StaticWorkspaceSource([]), auth: again),
				client: preview.client, events: EventHub(client: nil))
			let runtime2 = AppRuntime(environment: env2, forYouDirectory: dir)
			let resumed = runtime2.forYou

			#expect((resumed.outbox.entries.count == 1) == survives)
			#expect(FileManager.default.fileExists(atPath: file.path) == survives)
			resumed.outbox.discardAll()
			ForYouRuntime.deletePersistedOutbox(actorId: relogin, directory: dir)
		}
	}

	@Test("a view reading the runtime while signed out neither retains one nor touches a queue")
	func signedOutReadIsInert() async throws {
		let environment = AppEnvironment.preview(signedIn: false)
		let dir = tempDirectory()
		let runtime = AppRuntime(
			environment: environment,
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

// MARK: - Search results and new sheets

@MainActor
@Suite("AppRuntime search routing")
struct AppRuntimeSearchRoutingTests {
	private func result(_ kind: SearchKind, _ id: String) -> SearchResult {
		SearchResult(kind: kind, entityId: id, title: "T")
	}

	@Test("an object result opens the object sheet")
	func object() async {
		let (runtime, _) = await makeRuntime()
		runtime.openSearchResult(result(.object, "obj-1"))
		#expect(runtime.presentedObject == .init(id: "obj-1"))
	}

	@Test("a chat result selects Chats and requests that thread")
	func chat() async {
		let (runtime, _) = await makeRuntime()
		runtime.selectedTab = .search
		runtime.openSearchResult(result(.chat, "chat-1"))
		#expect(runtime.selectedTab == .chats)
		#expect(runtime.requestedConversationId == "chat-1")
	}

	@Test("an agent result opens the agent sheet; a file result then replaces it")
	func agentAndFile() async {
		let (runtime, _) = await makeRuntime()
		runtime.openSearchResult(result(.agent, "agent-1"))
		#expect(runtime.presentedAgentId == "agent-1")
		runtime.openSearchResult(result(.file, "file-1"))
		// One sheet at a time: the file replaces the agent instead of stacking on it.
		#expect(runtime.presentedFileId == "file-1")
		#expect(runtime.presentedAgentId == nil)
	}

	@Test("sign-out closes every sheet and returns to For you")
	func signOutClearsSheets() async {
		let (runtime, _) = await makeRuntime()
		runtime.openAgent("agent-1")
		runtime.showSettings = true
		runtime.selectedTab = .loops

		await runtime.signOut()

		#expect(runtime.presentation == nil)
		#expect(runtime.selectedTab == .forYou)
	}

	@Test("a session ended by the server also closes the new sheets")
	func sessionEndedClearsSheets() async {
		let (runtime, _) = await makeRuntime()
		runtime.openFile("file-1")

		runtime.sessionEnded()

		#expect(runtime.presentation == nil)
	}

	@Test("the tab bar has four tabs and search, no More")
	func tabs() {
		#expect(ShellTab.allCases == [.forYou, .chats, .loops, .objects, .search])
	}
}

// MARK: - One sheet, workspace changes

@MainActor
@Suite("AppRuntime presentation")
struct AppRuntimePresentationTests {
	@Test("a second presentation replaces the first instead of stacking")
	func replaces() async {
		let (runtime, _) = await makeRuntime()
		runtime.showSettings = true
		runtime.openObject("obj-1")  // a sheet action opening an object, in the same tick
		#expect(runtime.presentation == .object("obj-1"))
		#expect(runtime.showSettings == false)
	}

	@Test("closing a sheet that was already replaced does not close its replacement")
	func staleCloseIgnored() async {
		let (runtime, _) = await makeRuntime()
		runtime.showSettings = true
		runtime.openObject("obj-1")
		runtime.showSettings = false  // the settings sheet's late dismissal callback
		#expect(runtime.presentation == .object("obj-1"))
	}

	@Test("the file browser is a sheet that a late close of another sheet does not dismiss")
	func filesSheet() async {
		let (runtime, _) = await makeRuntime()
		runtime.showFiles = true
		#expect(runtime.presentation == .files)

		runtime.showSettings = false  // a stale dismissal of a sheet that is no longer showing
		#expect(runtime.showFiles)

		runtime.showFiles = false
		#expect(runtime.presentation == nil)
	}

	@Test("switching workspace drops sheets and a pending thread that belong to the old one")
	func workspaceSwitchDropsStale() async {
		let (runtime, environment) = await makeRuntime()
		runtime.sync()
		runtime.openObject("obj-from-ws-1")
		runtime.requestedConversationId = "chat-from-ws-1"

		environment.auth.selectWorkspace("ws-2")
		runtime.sync()

		#expect(runtime.presentation == nil)
		#expect(runtime.requestedConversationId == nil)
	}

	@Test("switching workspace returns to For you and closes the profile sheet")
	func workspaceSwitchResetsToForYou() async {
		let (runtime, environment) = await makeRuntime()
		runtime.sync()
		runtime.selectedTab = .objects
		runtime.showProfile = true

		environment.auth.selectWorkspace("ws-2")
		runtime.sync()

		#expect(runtime.selectedTab == .forYou)
		#expect(!runtime.showProfile)
	}

	@Test("the profile sheet is one presentation: asking for another replaces it")
	func profileIsOneSheet() async {
		let (runtime, _) = await makeRuntime()
		runtime.showProfile = true
		runtime.showSettings = true
		#expect(!runtime.showProfile)
		runtime.showProfile = false  // stale dismissal of a sheet that is no longer showing
		#expect(runtime.showSettings)
	}

	@Test("switching workspace leaves the settings sheet open (it rebuilds itself)")
	func workspaceSwitchKeepsSettings() async {
		let (runtime, environment) = await makeRuntime()
		runtime.sync()
		runtime.showSettings = true

		environment.auth.selectWorkspace("ws-2")
		runtime.sync()

		#expect(runtime.showSettings)
	}

	@Test("a session the server ended also resets the selected tab")
	func sessionEndedResetsTab() async {
		let (runtime, _) = await makeRuntime()
		runtime.selectedTab = .objects
		runtime.sessionEnded()
		#expect(runtime.selectedTab == .forYou)
	}

	@Test("signing out erases the user's search history from the device")
	func signOutClearsSearchHistory() async {
		let (runtime, _) = await makeRuntime()
		let recents = SearchRecents(actorId: "actor-1")
		recents.push("secret roadmap", workspaceId: "ws-1")
		#expect(recents.load(workspaceId: "ws-1") == ["secret roadmap"])

		await runtime.signOut()

		#expect(recents.load(workspaceId: "ws-1").isEmpty)
	}

	@Test("Search is the last tab, and the first is For you")
	func tabOrder() {
		#expect(ShellTab.allCases.first == .forYou)
		#expect(ShellTab.allCases.last == .search)
	}
}

// MARK: - Sync lifecycle

@MainActor
@Suite("AppRuntime sync")
struct AppRuntimeSyncTests {
	@Test("a signed-in sync starts the coordinator; signing out stops it")
	func coordinatorLifecycle() async {
		let (runtime, _) = await makeRuntime()
		#expect(runtime.syncCoordinator == nil)
		#expect(runtime.isOnline)  // no banner before we know

		runtime.sync()
		#expect(runtime.syncCoordinator != nil)

		await runtime.signOut()
		#expect(runtime.syncCoordinator == nil)
		#expect(runtime.isOnline)
	}

	@Test("a session ended by the server stops the coordinator too")
	func sessionEndedStops() async {
		let (runtime, _) = await makeRuntime()
		runtime.sync()
		#expect(runtime.syncCoordinator != nil)

		runtime.sessionEnded()

		#expect(runtime.syncCoordinator == nil)
	}

	@Test("syncing twice keeps the same coordinator for the same actor")
	func idempotent() async {
		let (runtime, _) = await makeRuntime()
		runtime.sync()
		let first = runtime.syncCoordinator
		runtime.sync()
		#expect(runtime.syncCoordinator === first)
	}

	@Test("signing out erases the cached copy of the account's data")
	func signOutWipesDiskCache() async {
		let (runtime, _) = await makeRuntime()
		let key = DiskCache.Key(actorId: "actor-1", workspaceId: "ws-1", name: "test-sync-wipe")
		DiskCache.shared.write(["secret"], key: key, version: 1)
		#expect(DiskCache.shared.read([String].self, key: key, version: 1)?.value == ["secret"])

		await runtime.signOut()

		#expect(DiskCache.shared.read([String].self, key: key, version: 1)?.value == nil)
	}
}
