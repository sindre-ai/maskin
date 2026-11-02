import Foundation
import Testing

@testable import MaskinCore

private struct StubAuthenticator: Authenticating {
	func login(email: String, password: String) async throws -> LoginResult {
		LoginResult(apiKey: "ank_x", actorId: "a", name: "A", email: nil, workspaceId: nil)
	}
}

@MainActor
private func signedInWithNothing() -> AuthSession {
	let store = InMemorySecretStore(
		try! JSONEncoder().encode(
			StoredSession(apiKey: "ank_x", actorId: "a", name: "A", email: nil, workspaceId: nil)))
	let auth = AuthSession(authenticator: StubAuthenticator(), store: store)
	auth.restore()
	return auth
}

/// Answers `create` immediately, or parks it on `gate` so a test can tap twice.
private final class FakeCreator: WorkspaceAdminAPI, @unchecked Sendable {
	private let lock = NSLock()
	private var _calls: [(name: String, key: String)] = []
	var failure: Error?
	/// When set, `create` parks here (after recording its call) until the test releases it.
	var gate: Gate?
	var calls: [(name: String, key: String)] { lock.withLock { _calls } }

	func rename(workspaceId: String, name: String, idempotencyKey: String) async throws {}
	func create(name: String, idempotencyKey: String) async throws -> CreatedWorkspace {
		lock.withLock { _calls.append((name, idempotencyKey)) }
		await gate?.wait()
		if let failure { throw failure }
		return CreatedWorkspace(id: "ws-new", name: name)
	}
}

@MainActor
@Suite("FirstWorkspaceStore")
struct FirstWorkspaceStoreTests {
	private func makeWorkspaces() async -> (WorkspaceStore, AuthSession) {
		let auth = signedInWithNothing()
		let workspaces = WorkspaceStore(source: StaticWorkspaceSource([]), auth: auth)
		await workspaces.refresh()
		return (workspaces, auth)
	}

	private func makeStore(
		_ api: FakeCreator, _ workspaces: WorkspaceStore, online: Bool = true
	) -> FirstWorkspaceStore {
		FirstWorkspaceStore(
			api: api, isOnline: { online },
			didCreate: { workspaces.created(id: $0.id, name: $0.name) })
	}

	@Test("success lists and selects the new workspace, leaving the empty state")
	func success() async {
		let (workspaces, auth) = await makeWorkspaces()
		#expect(workspaces.hasNoWorkspaces)
		let api = FakeCreator()
		let store = makeStore(api, workspaces)
		store.name = "  Acme  "
		#expect(await store.create())
		#expect(api.calls.map(\.name) == ["Acme"])
		#expect(!workspaces.hasNoWorkspaces)
		#expect(workspaces.selectedID == "ws-new")
		#expect(auth.credentials?.workspaceId == "ws-new")
		#expect(workspaces.selected?.role == "owner")
		#expect(store.error == nil)
	}

	@Test("a blank name never reaches the server")
	func blank() async {
		let (workspaces, _) = await makeWorkspaces()
		let api = FakeCreator()
		let store = makeStore(api, workspaces)
		store.name = "   "
		#expect(!store.canCreate)
		#expect(await store.create() == false)
		#expect(api.calls.isEmpty)
	}

	@Test("failure keeps the screen, the name and shows the server's message")
	func failure() async {
		let (workspaces, _) = await makeWorkspaces()
		let api = FakeCreator()
		api.failure = SettingsError("Your plan doesn't allow another workspace.")
		let store = makeStore(api, workspaces)
		store.name = "Acme"
		#expect(await store.create() == false)
		#expect(store.error == "Your plan doesn't allow another workspace.")
		#expect(store.name == "Acme")
		#expect(workspaces.hasNoWorkspaces)
		#expect(!store.isCreating)
	}

	@Test("an unknown failure gets a plain sentence, never the raw error")
	func unknown() async {
		let (workspaces, _) = await makeWorkspaces()
		let api = FakeCreator()
		api.failure = NSError(domain: "boom", code: 7)
		let store = makeStore(api, workspaces)
		store.name = "Acme"
		await store.create()
		#expect(store.error == "Couldn't create the workspace. Try again.")
	}

	@Test("a transport failure reads as offline")
	func transportOffline() async {
		let (workspaces, _) = await makeWorkspaces()
		let api = FakeCreator()
		api.failure = URLError(.notConnectedToInternet)
		let store = makeStore(api, workspaces)
		store.name = "Acme"
		await store.create()
		#expect(store.error == FirstWorkspaceStore.offlineMessage)
		#expect(workspaces.hasNoWorkspaces)
	}

	@Test("known offline never sends the request")
	func offline() async {
		let (workspaces, _) = await makeWorkspaces()
		let api = FakeCreator()
		let store = makeStore(api, workspaces, online: false)
		store.name = "Acme"
		#expect(await store.create() == false)
		#expect(api.calls.isEmpty)
		#expect(store.error == FirstWorkspaceStore.offlineMessage)
	}

	@Test("a second tap while the first is in flight is ignored")
	func doubleTap() async {
		let (workspaces, _) = await makeWorkspaces()
		let api = FakeCreator()
		let gate = Gate()
		api.gate = gate
		let store = makeStore(api, workspaces)
		store.name = "Acme"
		let first = Task { await store.create() }
		// Held inside the server call until the second tap has been attempted, so "in flight" is a
		// fact of the test and not a scheduling accident.
		await gate.waitUntilStarted()
		#expect(store.isCreating)
		#expect(await store.create() == false)
		await gate.release()
		#expect(await first.value)
		#expect(api.calls.count == 1)
	}

	@Test("retrying the same name after a failure reuses the idempotency key")
	func keyReuse() async {
		let (workspaces, _) = await makeWorkspaces()
		let api = FakeCreator()
		api.failure = URLError(.networkConnectionLost)
		let store = makeStore(api, workspaces)
		store.name = "Acme"
		await store.create()
		api.failure = nil
		#expect(await store.create())
		let keys = api.calls.map(\.key)
		#expect(keys.count == 2 && keys[0] == keys[1])
	}

	@Test("a different name gets a fresh key")
	func keyChange() async {
		let (workspaces, _) = await makeWorkspaces()
		let api = FakeCreator()
		api.failure = SettingsError("no")
		let store = makeStore(api, workspaces)
		store.name = "Acme"
		await store.create()
		store.name = "Beta"
		await store.create()
		let keys = api.calls.map(\.key)
		#expect(keys.count == 2 && keys[0] != keys[1])
	}

	@Test("creating clears a pending account-deletion offer")
	func clearsOffer() async {
		let auth = signedInWithNothing()
		let one = WorkspaceSummary(id: "w1", name: "One", role: "owner", memberCount: 1)
		let workspaces = WorkspaceStore(source: StaticWorkspaceSource([one]), auth: auth)
		await workspaces.refresh()
		workspaces.removed("w1")
		#expect(workspaces.offersAccountDeletion)
		workspaces.created(id: "w2", name: "Two")
		#expect(!workspaces.offersAccountDeletion)
		#expect(workspaces.selectedID == "w2")
	}
}
