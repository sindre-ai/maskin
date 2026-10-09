import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

private struct StubAuthenticator: Authenticating {
	func login(email: String, password: String) async throws -> LoginResult {
		LoginResult(apiKey: "ank_x", actorId: "a", name: "A", email: nil, workspaceId: nil)
	}
}

private let one = WorkspaceSummary(id: "w1", name: "One", role: "owner", memberCount: 1)
private let two = WorkspaceSummary(id: "w2", name: "Two", role: "member", memberCount: 3)

@MainActor
private func signedIn(workspaceId: String?) -> AuthSession {
	let store = InMemorySecretStore(
		try! JSONEncoder().encode(
			StoredSession(
				apiKey: "ank_x", actorId: "a", name: "A", email: nil, workspaceId: workspaceId)))
	let auth = AuthSession(authenticator: StubAuthenticator(), store: store)
	auth.restore()
	return auth
}

@MainActor
@Suite("WorkspaceStore")
struct WorkspaceStoreTests {
	@Test("auto-picks the first workspace when none is selected")
	func autoPick() async {
		let auth = signedIn(workspaceId: nil)
		let store = WorkspaceStore(source: StaticWorkspaceSource([one, two]), auth: auth)
		await store.refresh()
		#expect(store.workspaces == [one, two])
		#expect(store.selectedID == "w1")
		#expect(auth.credentials?.workspaceId == "w1")
		#expect(store.phase == .loaded)
	}

	@Test("keeps a valid selection")
	func keeps() async {
		let auth = signedIn(workspaceId: "w2")
		let store = WorkspaceStore(source: StaticWorkspaceSource([one, two]), auth: auth)
		await store.refresh()
		#expect(store.selected == two)
	}

	@Test("repairs a selection that is no longer in the list")
	func repairs() async {
		let auth = signedIn(workspaceId: "gone")
		let store = WorkspaceStore(source: StaticWorkspaceSource([one]), auth: auth)
		await store.refresh()
		#expect(store.selectedID == "w1")
	}

	@Test("select switches the credentials' workspace; unknown ids are ignored")
	func select() async {
		let auth = signedIn(workspaceId: "w1")
		let store = WorkspaceStore(source: StaticWorkspaceSource([one, two]), auth: auth)
		await store.refresh()
		store.select("w2")
		#expect(auth.credentials?.workspaceId == "w2")
		store.select("nope")
		#expect(auth.credentials?.workspaceId == "w2")
	}

	@Test("a failed load keeps the previous list and reports the error")
	func failure() async {
		let auth = signedIn(workspaceId: "w1")
		let store = WorkspaceStore(
			source: StaticWorkspaceSource(failure: WorkspaceListingError("offline")), auth: auth)
		await store.refresh()
		#expect(store.phase == .failed("offline"))
		#expect(store.workspaces.isEmpty)
		#expect(store.selectedID == "w1")
	}

	@Test("refresh while signed out clears state")
	func signedOut() async {
		let auth = signedIn(workspaceId: "w1")
		let store = WorkspaceStore(source: StaticWorkspaceSource([one]), auth: auth)
		await store.refresh()
		auth.signOut()
		await store.refresh()
		#expect(store.workspaces.isEmpty)
		#expect(store.phase == .idle)
	}
}
