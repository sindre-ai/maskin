import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

private struct FakeAuthenticator: Authenticating {
	var result: Result<LoginResult, AuthError>
	func login(email: String, password: String) async throws -> LoginResult { try result.get() }
}

private let alice = LoginResult(
	apiKey: "ank_secret", actorId: "actor-1", name: "Alice", email: "alice@example.com",
	workspaceId: "ws-1")

/// A store whose reads / deletes can be made to throw, like a locked Keychain.
private final class FlakyStore: SecretStore, @unchecked Sendable {
	let inner: InMemorySecretStore
	var failReads = false
	var failDeletes = false
	init(inner: InMemorySecretStore) { self.inner = inner }
	func read() throws -> Data? {
		if failReads { throw KeychainError(status: -25308) }
		return try inner.read()
	}
	func write(_ data: Data) throws { try inner.write(data) }
	func delete() throws {
		if failDeletes { throw KeychainError(status: -25308) }
		try inner.delete()
	}
}

@MainActor
@Suite("AuthSession")
struct AuthSessionTests {
	@Test("signing in stores the session and exposes credentials")
	func signIn() async throws {
		let store = InMemorySecretStore()
		let auth = AuthSession(authenticator: FakeAuthenticator(result: .success(alice)), store: store)

		await auth.signIn(email: "alice@example.com", password: "pw")

		#expect(auth.credentials == MaskinCredentials(apiKey: "ank_secret", workspaceId: "ws-1"))
		#expect(try store.read() != nil)
		#expect(auth.lastError == nil)
	}

	@Test("bad credentials leave the user signed out and store nothing")
	func invalid() async throws {
		let store = InMemorySecretStore()
		let auth = AuthSession(
			authenticator: FakeAuthenticator(result: .failure(.invalidCredentials)), store: store)

		await auth.signIn(email: "a@b.c", password: "wrong")

		#expect(auth.state == .signedOut)
		#expect(auth.lastError == .invalidCredentials)
		#expect(try store.read() == nil)
	}

	@Test("restore() brings back a session stored by a previous launch")
	func restore() async {
		let store = InMemorySecretStore()
		let first = AuthSession(authenticator: FakeAuthenticator(result: .success(alice)), store: store)
		await first.signIn(email: "a", password: "b")

		let relaunched = AuthSession(
			authenticator: FakeAuthenticator(result: .failure(.invalidCredentials)), store: store)
		relaunched.restore()

		#expect(relaunched.session?.actorId == "actor-1")
	}

	@Test("a blob this build can't decode signs out but is not deleted")
	func undecodable() throws {
		let store = InMemorySecretStore(Data("not json".utf8))
		let auth = AuthSession(authenticator: FakeAuthenticator(result: .success(alice)), store: store)

		auth.restore()

		#expect(auth.state == .signedOut)
		#expect(auth.restoreFailed)
		#expect(try store.read() == Data("not json".utf8), "a newer build's blob must survive")
	}

	@Test("a blob with extra or missing optional fields still restores")
	func tolerantDecode() throws {
		let future = #"{"apiKey":"k","actorId":"a1","name":"A","newField":{"x":1}}"#
		let auth = AuthSession(
			authenticator: FakeAuthenticator(result: .success(alice)),
			store: InMemorySecretStore(Data(future.utf8)))

		auth.restore()

		#expect(auth.session?.actorId == "a1")
		#expect(auth.session?.workspaceId == nil)
	}

	@Test("a Keychain read that throws leaves the stored session alone")
	func readThrows() throws {
		let store = FlakyStore(inner: InMemorySecretStore(try JSONEncoder().encode(StoredSession(apiKey: "k", actorId: "a", name: "A"))))
		store.failReads = true
		let auth = AuthSession(authenticator: FakeAuthenticator(result: .success(alice)), store: store)

		auth.restore()
		#expect(auth.state == .signedOut)
		#expect(auth.restoreFailed)

		store.failReads = false
		auth.restore()
		#expect(auth.session?.actorId == "a", "a later restore finds the untouched session")
		#expect(!auth.restoreFailed)
	}

	@Test("sign-out whose Keychain delete failed does not resurrect at the next launch")
	func failedDeleteIsFinishedLater() async throws {
		let store = FlakyStore(inner: InMemorySecretStore())
		let marker = InMemorySignOutMarker()
		let auth = AuthSession(
			authenticator: FakeAuthenticator(result: .success(alice)), store: store, signOutMarker: marker)
		await auth.signIn(email: "a", password: "b")

		store.failDeletes = true
		auth.signOut()
		#expect(auth.state == .signedOut)
		#expect(await auth.credentialsProvider() == nil)
		#expect(marker.isSet)
		#expect(try store.read() != nil, "the delete really did fail")

		// Relaunch: the Keychain is writable again.
		store.failDeletes = false
		let relaunched = AuthSession(
			authenticator: FakeAuthenticator(result: .success(alice)), store: store, signOutMarker: marker)
		relaunched.restore()

		#expect(relaunched.state == .signedOut)
		#expect(try store.read() == nil)
		#expect(!marker.isSet)
	}

	@Test("while the delete keeps failing the next launch still stays signed out")
	func stillFailingStaysSignedOut() async throws {
		let store = FlakyStore(inner: InMemorySecretStore())
		let marker = InMemorySignOutMarker()
		let auth = AuthSession(
			authenticator: FakeAuthenticator(result: .success(alice)), store: store, signOutMarker: marker)
		await auth.signIn(email: "a", password: "b")
		store.failDeletes = true
		auth.signOut()

		let relaunched = AuthSession(
			authenticator: FakeAuthenticator(result: .success(alice)), store: store, signOutMarker: marker)
		relaunched.restore()

		#expect(relaunched.state == .signedOut)
		#expect(marker.isSet)
	}

	@Test("a 401 for the live key ends the session and says why")
	func rejectedKey() async throws {
		let store = InMemorySecretStore()
		let auth = AuthSession(authenticator: FakeAuthenticator(result: .success(alice)), store: store)
		await auth.signIn(email: "a", password: "b")

		auth.sessionRejected(apiKey: "ank_secret")

		#expect(auth.state == .signedOut)
		#expect(auth.sessionExpired)
		#expect(try store.read() == nil)
	}

	@Test("session-end handlers run with the ending session, before it is cleared, on sign-out and 401")
	func sessionEndHandlers() async {
		let auth = AuthSession(
			authenticator: FakeAuthenticator(result: .success(alice)), store: InMemorySecretStore())
		var seen: [(String, Bool)] = []
		auth.onSessionEnded { [auth] ending in seen.append((ending.apiKey, auth.session != nil)) }
		await auth.signIn(email: "a", password: "b")
		auth.signOut()
		await auth.signIn(email: "a", password: "b")
		auth.sessionRejected(apiKey: "ank_secret")
		auth.signOut()  // already signed out: nothing to end
		#expect(seen.count == 2)
		#expect(seen.allSatisfy { $0.0 == "ank_secret" && $0.1 })
	}

	@Test("a late 401 for an old key does not sign out the new session")
	func staleRejection() async {
		let auth = AuthSession(
			authenticator: FakeAuthenticator(result: .success(alice)), store: InMemorySecretStore())
		await auth.signIn(email: "a", password: "b")

		auth.sessionRejected(apiKey: "ank_some_old_key")

		#expect(auth.session?.actorId == "actor-1")
		#expect(!auth.sessionExpired)
	}

	@Test("signing in again clears the expired flag")
	func signInClearsExpired() async {
		let auth = AuthSession(
			authenticator: FakeAuthenticator(result: .success(alice)), store: InMemorySecretStore())
		await auth.signIn(email: "a", password: "b")
		auth.sessionRejected(apiKey: "ank_secret")
		await auth.signIn(email: "a", password: "b")
		#expect(!auth.sessionExpired)
		#expect(auth.session != nil)
	}

	@Test("the credentials provider follows a workspace switch without being rebuilt")
	func workspaceSwitch() async {
		let auth = AuthSession(
			authenticator: FakeAuthenticator(result: .success(alice)), store: InMemorySecretStore())
		await auth.signIn(email: "a", password: "b")
		let provider = auth.credentialsProvider

		auth.selectWorkspace("ws-2")

		#expect(await provider()?.workspaceId == "ws-2")
	}

	@Test("signing out clears the store and the provider")
	func signOut() async throws {
		let store = InMemorySecretStore()
		let auth = AuthSession(authenticator: FakeAuthenticator(result: .success(alice)), store: store)
		await auth.signIn(email: "a", password: "b")
		let provider = auth.credentialsProvider

		auth.signOut()

		#expect(await provider() == nil)
		#expect(try store.read() == nil)
	}
}

@MainActor
@Suite("AuthSession key rotation")
struct AuthSessionRotationTests {
	@Test("adopting a rotated key keeps the actor and workspace and persists it")
	func adopt() async throws {
		let store = InMemorySecretStore()
		let auth = AuthSession(authenticator: FakeAuthenticator(result: .success(alice)), store: store)
		await auth.signIn(email: "a", password: "b")

		try auth.adoptRotatedKey("ank_new")

		#expect(auth.credentials == MaskinCredentials(apiKey: "ank_new", workspaceId: "ws-1"))
		#expect(auth.session?.actorId == "actor-1")
		let relaunched = AuthSession(
			authenticator: FakeAuthenticator(result: .failure(.invalidCredentials)), store: store)
		relaunched.restore()
		#expect(relaunched.session?.apiKey == "ank_new")
	}

	@Test("a late 401 for the OLD key must not sign out the new session")
	func staleRejectionIgnored() async throws {
		let auth = AuthSession(
			authenticator: FakeAuthenticator(result: .success(alice)), store: InMemorySecretStore())
		await auth.signIn(email: "a", password: "b")
		try auth.adoptRotatedKey("ank_new")

		auth.sessionRejected(apiKey: "ank_secret")  // the pre-rotation key

		#expect(auth.session?.apiKey == "ank_new")
		#expect(auth.sessionExpired == false)
		auth.sessionRejected(apiKey: "ank_new")  // but the live key being refused does end it
		#expect(auth.state == .signedOut)
		#expect(auth.sessionExpired)
	}

	@Test("adopting while signed out, or an empty key, throws and changes nothing")
	func guards() async throws {
		let auth = AuthSession(
			authenticator: FakeAuthenticator(result: .success(alice)), store: InMemorySecretStore())
		#expect(throws: AuthSessionError.notSignedIn) { try auth.adoptRotatedKey("ank_x") }
		await auth.signIn(email: "a", password: "b")
		#expect(throws: AuthSessionError.emptyKey) { try auth.adoptRotatedKey("") }
		#expect(auth.session?.apiKey == "ank_secret")
	}
}

@MainActor
@Suite("AuthSession rotation guard and rename")
struct AuthSessionRotationGuardTests {
	@Test("a 401 for the live key is ignored while a rotation is in progress")
	func rejectionIgnoredDuringRotation() async throws {
		let auth = AuthSession(
			authenticator: FakeAuthenticator(result: .success(alice)), store: InMemorySecretStore())
		await auth.signIn(email: "a", password: "b")

		auth.beginKeyRotation()
		auth.sessionRejected(apiKey: "ank_secret")  // in-flight request with the about-to-die key

		#expect(auth.session != nil)
		#expect(auth.sessionExpired == false)
		try auth.adoptRotatedKey("ank_new")
		#expect(auth.isRotatingKey == false)
	}

	@Test("cancelling a failed rotation makes 401s count again")
	func cancelRestoresRejection() async {
		let auth = AuthSession(
			authenticator: FakeAuthenticator(result: .success(alice)), store: InMemorySecretStore())
		await auth.signIn(email: "a", password: "b")
		auth.beginKeyRotation()
		auth.cancelKeyRotation()

		auth.sessionRejected(apiKey: "ank_secret")

		#expect(auth.state == .signedOut)
	}

	@Test("signing out clears a rotation left half-done")
	func signOutClearsFlag() async {
		let auth = AuthSession(
			authenticator: FakeAuthenticator(result: .success(alice)), store: InMemorySecretStore())
		await auth.signIn(email: "a", password: "b")
		auth.beginKeyRotation()
		auth.signOut()
		#expect(auth.isRotatingKey == false)
	}

	@Test("a renamed profile reaches the session and survives a relaunch")
	func updateName() async {
		let store = InMemorySecretStore()
		let auth = AuthSession(authenticator: FakeAuthenticator(result: .success(alice)), store: store)
		await auth.signIn(email: "a", password: "b")

		auth.updateName("Alice B.")

		#expect(auth.session?.name == "Alice B.")
		let relaunched = AuthSession(
			authenticator: FakeAuthenticator(result: .failure(.invalidCredentials)), store: store)
		relaunched.restore()
		#expect(relaunched.session?.name == "Alice B.")
		auth.updateName("")  // an empty name is ignored
		#expect(auth.session?.name == "Alice B.")
	}
}

@Suite("KeychainSecretStore")
struct KeychainSecretStoreTests {
	@Test("round-trips, overwrites and deletes a value")
	func roundTrip() throws {
		let store = KeychainSecretStore(service: "io.maskin.tests.\(UUID().uuidString)")
		defer { try? store.delete() }

		#expect(try store.read() == nil)
		try store.write(Data("one".utf8))
		try store.write(Data("two".utf8))
		#expect(try store.read() == Data("two".utf8))
		try store.delete()
		#expect(try store.read() == nil)
	}
}
