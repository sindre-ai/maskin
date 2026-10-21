import Foundation
import Testing

@testable import MaskinCore

private final class FakeDeletion: DeletionAPI, @unchecked Sendable {
	private let lock = NSLock()
	var accountResult: Result<AccountDeletionPreview, DeletionError> = .success(
		AccountDeletionPreview(canDelete: true, blockers: [], leaving: []))
	var workspaceResult: Result<WorkspaceDeletionPreview, DeletionError> = .success(
		WorkspaceDeletionPreview(
			workspaceId: "ws-1", workspaceName: "Mesh Firm", canDelete: true, blockers: [],
			otherMembers: 2))
	var deleteFailure: DeletionError?
	/// Answer used when the flag is on; falls back to `accountResult`.
	var flaggedAccountResult: Result<AccountDeletionPreview, DeletionError>?
	private var _calls: [String] = []
	var calls: [String] { lock.withLock { _calls }.filter { !$0.hasPrefix("preview") } }
	var previews: [String] { lock.withLock { _calls }.filter { $0.hasPrefix("preview") } }

	private func record(_ s: String) { lock.withLock { _calls.append(s) } }

	func accountPreview(deleteSoleWorkspaces: Bool) async throws -> AccountDeletionPreview {
		record("preview:\(deleteSoleWorkspaces)")
		return try (deleteSoleWorkspaces ? flaggedAccountResult ?? accountResult : accountResult).get()
	}
	func deleteAccount(password: String, deleteSoleWorkspaces: Bool, idempotencyKey: String)
		async throws
	{
		record("delete-account:\(password):\(deleteSoleWorkspaces)")
		if let deleteFailure { throw deleteFailure }
	}
	func workspacePreview(workspaceId: String) async throws -> WorkspaceDeletionPreview {
		try workspaceResult.get()
	}
	func deleteWorkspace(workspaceId: String, confirmName: String, idempotencyKey: String)
		async throws
	{
		record("delete-workspace:\(workspaceId):\(confirmName)")
		if let deleteFailure { throw deleteFailure }
	}
}

private func previewJSON(_ s: String) -> Data { Data(s.utf8) }

@Suite("Deletion wire decoding")
struct DeletionDecodingTests {
	@Test("decodes the account preview, snake_case")
	func accountPreview() throws {
		let json = """
			{"can_delete":false,
			 "blockers":[{"code":"transfer_ownership","workspace_id":"w1","workspace_name":"Acme"},
			             {"code":"cancel_plan","workspace_id":"w2","workspace_name":"Side"},
			             {"code":"something_new","workspace_id":"w3","workspace_name":"Odd"}],
			 "leaving":[{"workspace_id":"w1","workspace_name":"Acme","other_members":3,"will_delete":false},
			            {"workspace_id":"w4","workspace_name":"Solo","other_members":0,"will_delete":true}]}
			"""
		let preview = try APIDeletionSource.decode(AccountDeletionPreview.self, previewJSON(json))
		#expect(!preview.canDelete)
		#expect(preview.blockers.map(\.code) == [.transferOwnership, .cancelPlan, .other("something_new")])
		#expect(preview.blockers[0].workspaceName == "Acme")
		#expect(preview.soleWorkspaces.map(\.workspaceName) == ["Solo"])
		#expect(preview.sharedWorkspaces.map(\.otherMembers) == [3])
	}

	@Test("decodes the workspace preview")
	func workspacePreview() throws {
		let json = """
			{"workspace_id":"w1","workspace_name":"Acme","can_delete":false,
			 "blockers":[{"code":"not_billing_owner","message":"Only the billing owner can delete."}],
			 "other_members":4}
			"""
		let preview = try APIDeletionSource.decode(WorkspaceDeletionPreview.self, previewJSON(json))
		#expect(preview.blockers.first?.code == .notBillingOwner)
		#expect(preview.otherMembers == 4)
	}

	@Test("an unreadable body is a plain error, not a crash")
	func unreadable() {
		#expect(throws: DeletionError.self) {
			try APIDeletionSource.decode(AccountDeletionPreview.self, previewJSON("{}"))
		}
	}

	@Test("encodes the request bodies in snake_case")
	func bodies() throws {
		let a = try JSONEncoder().encode(
			APIDeletionSource.AccountDeleteBody(password: "pw", deleteSoleWorkspaces: true))
		let ao = try JSONSerialization.jsonObject(with: a) as? [String: Any]
		#expect(ao?["delete_sole_workspaces"] as? Bool == true)
		#expect(ao?["password"] as? String == "pw")
		let w = try JSONEncoder().encode(APIDeletionSource.WorkspaceDeleteBody(confirmName: "Acme"))
		#expect((try JSONSerialization.jsonObject(with: w) as? [String: Any])?["confirm_name"] as? String == "Acme")
	}

	@Test("error mapping prefers the server's message for 409, falls back otherwise")
	func errors() {
		let body = Data(#"{"error":{"code":"BLOCKED","message":"Cancel your plan first."}}"#.utf8)
		#expect(APIDeletionSource.error(status: 409, data: body, fallback: "x").message == "Cancel your plan first.")
		#expect(APIDeletionSource.error(status: 409, data: Data(), fallback: "x").message.contains("blocking"))
		#expect(APIDeletionSource.error(status: 500, data: body, fallback: "x").message == "x")
		#expect(APIDeletionSource.error(status: 429, data: Data(), fallback: "x").message.contains("Too many"))
	}

	@Test("the preview request adds the flag only when on")
	func previewQuery() async {
		let source = APIDeletionSource(
			baseURL: URL(string: "http://localhost:3000")!, clientSource: "ios", credentials: { nil })
		let on = await source.makeRequest(
			"GET", "api/account/deletion-preview", body: nil, idempotencyKey: nil,
			query: [URLQueryItem(name: "delete_sole_workspaces", value: "true")])
		#expect(on.url?.absoluteString == "http://localhost:3000/api/account/deletion-preview?delete_sole_workspaces=true")
	}

	@Test("the request carries bearer auth and an idempotency key, never a workspace header")
	func request() async throws {
		let source = APIDeletionSource(
			baseURL: URL(string: "http://localhost:3000")!, clientSource: "ios",
			credentials: { .init(apiKey: "ank_test", workspaceId: "ws-1") })
		let r = await source.makeRequest(
			"POST", "api/account/delete", body: Data("{}".utf8), idempotencyKey: "k1")
		#expect(r.url?.absoluteString == "http://localhost:3000/api/account/delete")
		#expect(r.value(forHTTPHeaderField: "Authorization") == "Bearer ank_test")
		#expect(r.value(forHTTPHeaderField: "Idempotency-Key") == "k1")
		#expect(r.value(forHTTPHeaderField: "X-Workspace-Id") == nil)
	}
}

@MainActor
@Suite("AccountDeletionStore")
struct AccountDeletionStoreTests {
	private func make(_ api: FakeDeletion, onDelete: @escaping @MainActor () async -> Void = {})
		-> AccountDeletionStore
	{
		AccountDeletionStore(api: api, didDelete: onDelete)
	}

	@Test("blockers keep deletion unavailable")
	func blocked() async {
		let api = FakeDeletion()
		api.accountResult = .success(
			AccountDeletionPreview(
				canDelete: false,
				blockers: [.init(code: .cancelPlan, workspaceId: "w", workspaceName: "Acme")], leaving: []))
		let store = make(api)
		await store.load()
		store.password = "pw"
		#expect(!store.canProceed)
		#expect(!store.canConfirm)
		#expect(await store.delete() == false)
		#expect(api.calls.isEmpty)
	}

	@Test("needs a password before it can confirm")
	func needsPassword() async {
		let store = make(FakeDeletion())
		await store.load()
		#expect(store.canProceed)
		#expect(!store.canConfirm)
		store.password = "pw"
		#expect(store.canConfirm)
	}

	@Test("sends the toggle and the password, then signs out and clears the password")
	func succeeds() async {
		let api = FakeDeletion()
		var signedOut = false
		let store = make(api) { signedOut = true }
		await store.load()
		store.password = "pw"
		store.deleteSoleWorkspaces = true
		#expect(await store.delete())
		#expect(api.calls == ["delete-account:pw:true"])
		#expect(signedOut)
		#expect(store.isDeleted)
		#expect(store.password.isEmpty)
	}

	@Test("the toggle is off unless chosen")
	func toggleDefault() async {
		let api = FakeDeletion()
		let store = make(api)
		await store.load()
		store.password = "pw"
		_ = await store.delete()
		#expect(api.calls == ["delete-account:pw:false"])
	}

	@Test("a wrong password shows the error, clears the field and does not sign out")
	func wrongPassword() async {
		let api = FakeDeletion()
		api.deleteFailure = .wrongPassword
		var signedOut = false
		let store = make(api) { signedOut = true }
		await store.load()
		store.password = "nope"
		#expect(await store.delete() == false)
		#expect(store.error == DeletionError.wrongPassword.message)
		#expect(store.password.isEmpty)
		#expect(!signedOut)
		#expect(!store.isDeleted)
	}

	@Test("turning the toggle on re-fetches and a new blocker disables confirming")
	func toggleRefetches() async {
		let api = FakeDeletion()
		api.flaggedAccountResult = .success(
			AccountDeletionPreview(
				canDelete: false,
				blockers: [.init(code: .cancelPlan, workspaceId: "w", workspaceName: "Solo")], leaving: []))
		let store = make(api)
		await store.load()
		store.password = "pw"
		#expect(store.canConfirm)
		store.deleteSoleWorkspaces = true
		await store.load()
		#expect(api.previews == ["preview:false", "preview:true"])
		#expect(!store.canConfirm)
		store.deleteSoleWorkspaces = false
		await store.load()
		#expect(store.canConfirm)
	}

	@Test("a failed preview says so and offers a retry")
	func previewFails() async {
		let api = FakeDeletion()
		api.accountResult = .failure(DeletionError("Offline."))
		let store = make(api)
		await store.load()
		#expect(store.phase == .failed("Offline."))
		api.accountResult = .success(AccountDeletionPreview(canDelete: true, blockers: [], leaving: []))
		await store.load()
		#expect(store.canProceed)
	}
}

@MainActor
@Suite("WorkspaceDeletionStore")
struct WorkspaceDeletionStoreTests {
	@Test("the typed name must match exactly, ignoring surrounding space")
	func nameMatch() async {
		let store = WorkspaceDeletionStore(api: FakeDeletion(), workspaceId: "ws-1") {}
		await store.load()
		store.typedName = "mesh firm"
		#expect(!store.canConfirm)
		store.typedName = "  Mesh Firm "
		#expect(store.canConfirm)
	}

	@Test("deleting sends the real name and runs the follow-up")
	func deletes() async {
		let api = FakeDeletion()
		var followed = false
		let store = WorkspaceDeletionStore(api: api, workspaceId: "ws-1") { followed = true }
		await store.load()
		store.typedName = "Mesh Firm"
		#expect(await store.delete())
		#expect(api.calls == ["delete-workspace:ws-1:Mesh Firm"])
		#expect(followed)
	}

	@Test("blockers disable deletion even with the right name")
	func blocked() async {
		let api = FakeDeletion()
		api.workspaceResult = .success(
			WorkspaceDeletionPreview(
				workspaceId: "ws-1", workspaceName: "Mesh Firm", canDelete: false,
				blockers: [.init(code: .notBillingOwner, message: "Only the billing owner can delete.")],
				otherMembers: 0))
		let store = WorkspaceDeletionStore(api: api, workspaceId: "ws-1") {}
		await store.load()
		store.typedName = "Mesh Firm"
		#expect(!store.canConfirm)
		#expect(await store.delete() == false)
		#expect(api.calls.isEmpty)
	}

	@Test("a server refusal is shown and nothing follows")
	func refused() async {
		let api = FakeDeletion()
		api.deleteFailure = DeletionError("Cancel the plan first.")
		var followed = false
		let store = WorkspaceDeletionStore(api: api, workspaceId: "ws-1") { followed = true }
		await store.load()
		store.typedName = "Mesh Firm"
		#expect(await store.delete() == false)
		#expect(store.error == "Cancel the plan first.")
		#expect(!followed)
	}
}

@MainActor
@Suite("Workspace selection after deletion")
struct WorkspaceRemovedTests {
	private func make(_ list: [WorkspaceSummary]) async -> (WorkspaceStore, AuthSession) {
		let secrets = InMemorySecretStore()
		let stored = StoredSession(
			apiKey: "ank_x", actorId: "a1", name: "A", email: nil, workspaceId: list.first?.id)
		try? secrets.write(try! JSONEncoder().encode(stored))
		let auth = AuthSession(authenticator: NoLogin(), store: secrets)
		auth.restore()
		let store = WorkspaceStore(source: StaticWorkspaceSource(list), auth: auth)
		await store.refresh()
		return (store, auth)
	}

	private struct NoLogin: Authenticating {
		func login(email: String, password: String) async throws -> LoginResult {
			throw AuthError.invalidCredentials
		}
	}

	private let a = WorkspaceSummary(id: "a", name: "A", role: "owner", memberCount: 1)
	private let b = WorkspaceSummary(id: "b", name: "B", role: "owner", memberCount: 1)

	@Test("removing the selected workspace selects another")
	func selectsNext() async {
		let (store, auth) = await make([a, b])
		store.removed("a")
		#expect(store.workspaces.map(\.id) == ["b"])
		#expect(auth.session?.workspaceId == "b")
	}

	@Test("removing the last workspace leaves the sign-in with no selection")
	func clearsSelection() async {
		let (store, auth) = await make([a])
		store.removed("a")
		#expect(store.workspaces.isEmpty)
		#expect(auth.session != nil)
		#expect(auth.session?.workspaceId == nil)
	}

	@Test("removing a different workspace keeps the selection")
	func keepsSelection() async {
		let (store, auth) = await make([a, b])
		store.removed("b")
		#expect(auth.session?.workspaceId == "a")
	}

	@Test("a deleted workspace's cached data is cleared, other workspaces' is kept")
	func clearsCaches() async throws {
		let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
		defer { try? FileManager.default.removeItem(at: dir) }
		let disk = DiskCache(directory: dir)
		let gone = DiskCache.Key(actorId: "a1", workspaceId: "a", name: "objects")
		let kept = DiskCache.Key(actorId: "a1", workspaceId: "b", name: "objects")
		disk.write(["x"], key: gone, version: 1)
		disk.write(["y"], key: kept, version: 1)
		let secrets = InMemorySecretStore()
		try secrets.write(try JSONEncoder().encode(
			StoredSession(apiKey: "ank_x", actorId: "a1", name: "A", email: nil, workspaceId: "a")))
		let auth = AuthSession(authenticator: NoLogin(), store: secrets)
		auth.restore()
		let store = WorkspaceStore(source: StaticWorkspaceSource([a, b]), auth: auth, disk: disk)
		await store.refresh()
		store.removed("a")
		#expect(disk.read([String].self, key: gone, version: 1) == nil)
		#expect(disk.read([String].self, key: kept, version: 1)?.value == ["y"])
	}

	@Test("the last workspace is detected; with two, neither is last")
	func detectsLast() async {
		let (one, _) = await make([a])
		#expect(one.isLast("a"))
		#expect(!one.isLast("zzz"))
		let (two, _) = await make([a, b])
		#expect(!two.isLast("a"))
	}

	@Test("deleting the last workspace raises the account-deletion offer and the no-workspaces state")
	func offerAfterLast() async {
		let (store, _) = await make([a])
		#expect(!store.hasNoWorkspaces)
		#expect(!store.offersAccountDeletion)
		store.removed("a")
		#expect(store.offersAccountDeletion)
		#expect(store.hasNoWorkspaces)
	}

	@Test("deleting one of two raises no offer")
	func noOfferWithOthersLeft() async {
		let (store, _) = await make([a, b])
		store.removed("a")
		#expect(!store.offersAccountDeletion)
		#expect(!store.hasNoWorkspaces)
	}

	@Test("Not now clears the offer but the person still lands on the no-workspaces state")
	func notNow() async {
		let (store, _) = await make([a])
		store.removed("a")
		store.dismissAccountDeletionOffer()
		#expect(!store.offersAccountDeletion)
		#expect(store.hasNoWorkspaces)
	}

	@Test("a cold launch whose server answer is an empty list lands on no-workspaces, without an offer")
	func coldLaunchEmpty() async {
		let (store, auth) = await make([])
		#expect(auth.session != nil)
		#expect(store.hasNoWorkspaces)
		#expect(!store.offersAccountDeletion)
	}

	@Test("a failed load is never the no-workspaces state")
	func failureIsNotEmpty() async {
		let secrets = InMemorySecretStore()
		try? secrets.write(try! JSONEncoder().encode(
			StoredSession(apiKey: "ank_x", actorId: "a1", name: "A", email: nil, workspaceId: nil)))
		let auth = AuthSession(authenticator: NoLogin(), store: secrets)
		auth.restore()
		let store = WorkspaceStore(source: StaticWorkspaceSource(failure: .init("offline")), auth: auth)
		await store.refresh()
		#expect(!store.hasNoWorkspaces)
	}

	@Test("a cache-only empty list does not count until the server confirms")
	func cacheOnlyEmpty() throws {
		let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
		defer { try? FileManager.default.removeItem(at: dir) }
		let disk = DiskCache(directory: dir)
		disk.write([WorkspaceSummary](), key: DiskCache.Key(actorId: "a1", name: "workspaces.list"), version: 1)
		let secrets = InMemorySecretStore()
		try secrets.write(try JSONEncoder().encode(
			StoredSession(apiKey: "ank_x", actorId: "a1", name: "A", email: nil, workspaceId: nil)))
		let auth = AuthSession(authenticator: NoLogin(), store: secrets)
		auth.restore()
		let store = WorkspaceStore(source: StaticWorkspaceSource([a]), auth: auth, disk: disk)
		#expect(store.phase == .loaded)
		#expect(store.workspaces.isEmpty)
		#expect(!store.hasNoWorkspaces)
	}

	@Test("sign-out forgets a pending offer")
	func resetClearsOffer() async {
		let (store, _) = await make([a])
		store.removed("a")
		store.reset()
		#expect(!store.offersAccountDeletion)
		#expect(!store.hasNoWorkspaces)
	}

	@Test("the deletion store knows when it is deleting the last workspace")
	func deletionStoreFlag() {
		let store = WorkspaceDeletionStore(
			api: FakeDeletion(), workspaceId: "a", isLastWorkspace: true, didDelete: {})
		#expect(store.isLastWorkspace)
		#expect(!WorkspaceDeletionStore(api: FakeDeletion(), workspaceId: "a", didDelete: {}).isLastWorkspace)
	}

	@Test("a deliberate sign-out is never reported as an expired session")
	func signOutNotExpiry() async {
		let (_, auth) = await make([a])
		auth.sessionRejected(apiKey: "ank_x")
		#expect(auth.sessionExpired)
		auth.signOut()
		#expect(!auth.sessionExpired)
	}
}
