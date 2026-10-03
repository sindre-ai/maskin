import Foundation
import MaskinAPI
import Observation

/// The signed-in actor plus the credentials every request carries. Persisted as one blob so a
/// half-written session (key without workspace, say) can't exist.
public struct StoredSession: Codable, Sendable, Equatable {
	public var apiKey: String
	public var actorId: String
	public var name: String
	public var email: String?
	/// Selected workspace; `nil` until the user picks one (or login returned a default).
	public var workspaceId: String?

	public init(
		apiKey: String, actorId: String, name: String, email: String? = nil, workspaceId: String? = nil
	) {
		self.apiKey = apiKey
		self.actorId = actorId
		self.name = name
		self.email = email
		self.workspaceId = workspaceId
	}

	private enum CodingKeys: String, CodingKey {
		case apiKey, actorId, name, email, workspaceId
	}

	/// Optional fields use `decodeIfPresent`, so a blob written by an older or newer build still
	/// decodes instead of looking corrupt (and signing the user out).
	public init(from decoder: any Decoder) throws {
		let c = try decoder.container(keyedBy: CodingKeys.self)
		apiKey = try c.decode(String.self, forKey: .apiKey)
		actorId = try c.decode(String.self, forKey: .actorId)
		name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
		email = try c.decodeIfPresent(String.self, forKey: .email)
		workspaceId = try c.decodeIfPresent(String.self, forKey: .workspaceId)
	}
}

/// Remembers that a sign-out is owed a Keychain delete that failed, so the session can't come
/// back at the next launch. Tiny and separate from the `SecretStore` because that store is the
/// thing that just failed.
public protocol SignOutMarker: Sendable {
	var isSet: Bool { get }
	func set(_ value: Bool)
}

public final class InMemorySignOutMarker: SignOutMarker, @unchecked Sendable {
	private let lock = NSLock()
	private var value = false
	public init() {}
	public var isSet: Bool { lock.withLock { value } }
	public func set(_ value: Bool) { lock.withLock { self.value = value } }
}

public struct UserDefaultsSignOutMarker: SignOutMarker, @unchecked Sendable {
	private let defaults: UserDefaults
	private let key: String
	public init(defaults: UserDefaults = .standard, key: String = "auth.signOutPending.v1") {
		self.defaults = defaults
		self.key = key
	}
	public var isSet: Bool { defaults.bool(forKey: key) }
	public func set(_ value: Bool) { defaults.set(value, forKey: key) }
}

public struct LoginResult: Sendable, Equatable {
	public var apiKey: String
	public var actorId: String
	public var name: String
	public var email: String?
	public var workspaceId: String?

	public init(apiKey: String, actorId: String, name: String, email: String?, workspaceId: String?) {
		self.apiKey = apiKey
		self.actorId = actorId
		self.name = name
		self.email = email
		self.workspaceId = workspaceId
	}
}

public enum AuthSessionError: Error, Sendable, Equatable {
	case notSignedIn
	case emptyKey
}

public enum AuthError: Error, Sendable, Equatable {
	case invalidCredentials
	case server(status: Int)
	case network(String)
}

/// What `POST /api/actors` returned for a new human. `login` is the session to persist;
/// `workspaceProvisioningFailed` means the account exists (the key works) but the server could
/// not set up the first workspace, so the workspace list is empty until a refresh succeeds.
public struct SignUpResult: Sendable, Equatable {
	public var login: LoginResult
	public var workspaceProvisioningFailed: Bool

	public init(login: LoginResult, workspaceProvisioningFailed: Bool = false) {
		self.login = login
		self.workspaceProvisioningFailed = workspaceProvisioningFailed
	}
}

/// Why account creation failed. Separate from `AuthError`: sign-up has outcomes sign-in doesn't
/// (a taken email, per-field validation), and no credential is ever carried in a case.
public enum SignUpError: Error, Sendable, Equatable {
	/// 409: an account with this email exists.
	case emailTaken
	/// 400: the server rejected these fields. Keys are the request's field names
	/// (`name`, `email`, `password`); values are the server's own sentence.
	case invalid(fields: [String: String])
	/// 429.
	case rateLimited
	case server(status: Int)
	case network(String)
}

/// Sign-in and sign-up. A protocol so `AuthSession` is testable without a server.
public protocol Authenticating: Sendable {
	/// `POST /api/auth/login`.
	func login(email: String, password: String) async throws -> LoginResult
	/// `POST /api/actors` (human signup). `idempotencyKey` is stamped on the request so a retry
	/// after a lost response is recognised instead of 409ing on the account it just made.
	func signUp(name: String, email: String, password: String, idempotencyKey: String) async throws
		-> SignUpResult
}

extension Authenticating {
	/// Conformers that only sign in (test doubles, the offline preview) needn't implement it.
	public func signUp(name: String, email: String, password: String, idempotencyKey: String)
		async throws -> SignUpResult
	{
		throw SignUpError.network("Sign-up isn't available here.")
	}
}

@MainActor
@Observable
public final class AuthSession {
	public enum State: Equatable, Sendable {
		case signedOut
		case signedIn(StoredSession)
	}

	public private(set) var state: State = .signedOut
	public private(set) var isSigningIn = false
	public private(set) var lastError: AuthError?
	public private(set) var isSigningUp = false
	public private(set) var lastSignUpError: SignUpError?
	/// Set by a sign-up that created the account but not its first workspace. The account and key
	/// are saved; the shell's workspace refresh is the retry. Cleared by the next sign-in/up.
	public private(set) var workspaceProvisioningFailed = false
	/// The server rejected the stored key (revoked or rotated) and the session was ended for it.
	/// The login screen should say so; cleared by the next sign-in.
	public private(set) var sessionExpired = false
	/// Set when `restore()` could not read the Keychain (as opposed to finding nothing): the
	/// stored session, if any, was left alone and a later `restore()` can try again.
	public private(set) var restoreFailed = false

	/// True between starting a key rotation and adopting the new key (or giving up). While the server
	/// may already have switched keys but this device hasn't yet, an in-flight request still carries
	/// the dead key and gets 401: that must not end the session.
	public private(set) var isRotatingKey = false

	@ObservationIgnored private let authenticator: any Authenticating
	@ObservationIgnored private let store: any SecretStore
	@ObservationIgnored private let signOutMarker: any SignOutMarker
	@ObservationIgnored public let firstUse: any FirstUseStore

	public init(
		authenticator: any Authenticating, store: any SecretStore,
		signOutMarker: any SignOutMarker = InMemorySignOutMarker(),
		firstUse: any FirstUseStore = UserDefaultsFirstUseStore()
	) {
		self.authenticator = authenticator
		self.store = store
		self.signOutMarker = signOutMarker
		self.firstUse = firstUse
	}

	public var session: StoredSession? {
		if case .signedIn(let s) = state { return s }
		return nil
	}

	public var credentials: MaskinCredentials? {
		session.map { MaskinCredentials(apiKey: $0.apiKey, workspaceId: $0.workspaceId) }
	}

	/// Hand to `MaskinClient` / `SSEClient`. Reads the live session on every request, so signing
	/// out or switching workspace applies to the next call without rebuilding a client.
	public nonisolated var credentialsProvider: MaskinCredentialsProvider {
		{ [weak self] in await self?.credentials }
	}

	/// Load a previously stored session at launch. Only a successful read of "nothing" means
	/// signed out for good; a read that throws (Keychain locked, transient) or a blob this build
	/// can't decode leaves the stored item untouched, so a hiccup or a newer build's blob never
	/// wipes the session. A sign-out whose Keychain delete failed is finished here first.
	public func restore() {
		restoreFailed = false
		if signOutMarker.isSet {
			do {
				try store.delete()
				signOutMarker.set(false)
			} catch {
				return  // still can't delete: stay signed out, try again next launch
			}
		}
		let data: Data?
		do {
			data = try store.read()
		} catch {
			restoreFailed = true
			return
		}
		guard let data else { return }
		guard let stored = try? JSONDecoder().decode(StoredSession.self, from: data) else {
			restoreFailed = true
			return
		}
		state = .signedIn(stored)
	}

	public func signIn(email: String, password: String) async {
		guard !isSigningIn else { return }
		isSigningIn = true
		lastError = nil
		lastSignUpError = nil
		workspaceProvisioningFailed = false
		sessionExpired = false
		defer { isSigningIn = false }
		do {
			let result = try await authenticator.login(email: email, password: password)
			let stored = StoredSession(
				apiKey: result.apiKey, actorId: result.actorId, name: result.name,
				email: result.email, workspaceId: result.workspaceId)
			try persist(stored)
			signOutMarker.set(false)
			state = .signedIn(stored)
		} catch let error as AuthError {
			lastError = error
		} catch {
			lastError = .network(error.localizedDescription)
		}
	}

	/// Create a human account and sign in with it. The session is persisted through the same path
	/// as `signIn`; on any failure nothing is stored. Marks the actor's first-use moment pending
	/// BEFORE the session goes live, so the screen that follows can't be skipped by a quick quit.
	/// A `workspaceProvisioningFailed` result is still a success: the account exists.
	public func signUp(name: String, email: String, password: String) async {
		guard !isSigningUp, !isSigningIn else { return }
		isSigningUp = true
		lastError = nil
		lastSignUpError = nil
		workspaceProvisioningFailed = false
		sessionExpired = false
		defer { isSigningUp = false }
		do {
			let result = try await authenticator.signUp(
				name: name, email: email, password: password, idempotencyKey: IdempotencyKey.make())
			let login = result.login
			let stored = StoredSession(
				apiKey: login.apiKey, actorId: login.actorId, name: login.name.isEmpty ? name : login.name,
				email: login.email ?? email, workspaceId: login.workspaceId)
			try persist(stored)
			signOutMarker.set(false)
			firstUse.markPending(actorId: stored.actorId)
			workspaceProvisioningFailed = result.workspaceProvisioningFailed
			state = .signedIn(stored)
		} catch let error as SignUpError {
			lastSignUpError = error
		} catch {
			lastSignUpError = .network(error.localizedDescription)
		}
	}

	/// Take a session another device of the same person already holds (the iPhone handing its
	/// sign-in to the paired watch). Persists before it changes state, like `signIn`.
	public func adopt(_ stored: StoredSession) throws {
		try persist(stored)
		signOutMarker.set(false)
		lastError = nil
		sessionExpired = false
		state = .signedIn(stored)
	}

	public func selectWorkspace(_ id: String) {
		guard var s = session, s.workspaceId != id else { return }
		s.workspaceId = id
		try? persist(s)
		state = .signedIn(s)
	}

	/// End the session. The in-memory state clears at once (requests stop carrying the key), but
	/// if the Keychain delete fails the owed delete is remembered and finished by the next
	/// `restore()`, so the session can't resurrect at launch.
	public func signOut() {
		isRotatingKey = false
		clearStored()
		state = .signedOut
	}

	/// Call right BEFORE asking the server to rotate this actor's key. Until `adoptRotatedKey`
	/// (or `cancelKeyRotation` if the call failed) a 401 from the old key is ignored.
	public func beginKeyRotation() { isRotatingKey = true }

	/// The rotation call failed without issuing a new key: 401s count again.
	public func cancelKeyRotation() { isRotatingKey = false }

	/// Update the display name after a successful profile edit, so every surface that shows
	/// the signed-in user stops being stale. Persisted with the rest of the session.
	public func updateName(_ name: String) {
		guard var s = session, !name.isEmpty, s.name != name else { return }
		s.name = name
		try? persist(s)
		state = .signedIn(s)
	}

	/// Adopt a key the server just issued for THIS actor (rotating invalidates the old one at once),
	/// keeping actor, name, email and workspace. Persists before it changes state, so a failed
	/// write leaves the old session untouched and the caller can say so. Call it before any other
	/// `await` after the rotate response: until then every request still carries the dead key.
	public func adoptRotatedKey(_ apiKey: String) throws {
		guard var s = session else { throw AuthSessionError.notSignedIn }
		guard !apiKey.isEmpty else { throw AuthSessionError.emptyKey }
		s.apiKey = apiKey
		try persist(s)
		state = .signedIn(s)
		isRotatingKey = false
	}

	/// A request made with `apiKey` came back 401. Ends the session, but only if that key is still
	/// the live one: a late 401 from before a re-login must not sign the new session out.
	public func sessionRejected(apiKey: String) {
		guard session?.apiKey == apiKey, !isRotatingKey else { return }
		clearStored()
		state = .signedOut
		sessionExpired = true
	}

	private func clearStored() {
		do {
			try store.delete()
			signOutMarker.set(false)
		} catch {
			signOutMarker.set(true)
		}
	}

	private func persist(_ s: StoredSession) throws {
		try store.write(try JSONEncoder().encode(s))
	}
}
