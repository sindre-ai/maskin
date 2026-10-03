import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import MaskinAPI
@testable import MaskinCore

private let secret = "correct-horse-battery"

private struct FakeSignUp: Authenticating {
	var result: Result<SignUpResult, any Error>
	var recorder = KeyRecorder()
	func login(email: String, password: String) async throws -> LoginResult {
		throw AuthError.invalidCredentials
	}
	func signUp(name: String, email: String, password: String, idempotencyKey: String) async throws
		-> SignUpResult
	{
		recorder.keys.withLock { $0.append(idempotencyKey) }
		return try result.get()
	}
}

private final class KeyRecorder: @unchecked Sendable {
	let keys = SignUpLockedBox<[String]>([])
}

private final class SignUpLockedBox<T>: @unchecked Sendable {
	private let lock = NSLock()
	private var value: T
	init(_ value: T) { self.value = value }
	func withLock<R>(_ body: (inout T) -> R) -> R { lock.withLock { body(&value) } }
}

private let created = SignUpResult(
	login: LoginResult(
		apiKey: "ank_new", actorId: "actor-9", name: "Sam", email: "sam@example.com", workspaceId: "ws-9"))

@MainActor
@Suite("AuthSession sign-up")
struct AuthSignUpTests {
	private func make(_ result: Result<SignUpResult, any Error>, store: InMemorySecretStore = .init())
		-> (AuthSession, InMemorySecretStore, InMemoryFirstUseStore, FakeSignUp)
	{
		let fake = FakeSignUp(result: result)
		let firstUse = InMemoryFirstUseStore()
		let auth = AuthSession(authenticator: fake, store: store, firstUse: firstUse)
		return (auth, store, firstUse, fake)
	}

	@Test("success persists the session through the same blob as sign-in and marks first use")
	func success() async throws {
		let (auth, store, firstUse, fake) = make(.success(created))

		await auth.signUp(name: "Sam", email: "sam@example.com", password: secret)

		let stored = try JSONDecoder().decode(StoredSession.self, from: try #require(try store.read()))
		#expect(stored.apiKey == "ank_new")
		#expect(stored.workspaceId == "ws-9")
		#expect(auth.credentials == MaskinCredentials(apiKey: "ank_new", workspaceId: "ws-9"))
		#expect(auth.lastSignUpError == nil)
		#expect(!auth.workspaceProvisioningFailed)
		#expect(firstUse.isPending(actorId: "actor-9"))
		let keys = fake.recorder.keys.withLock { $0 }
		#expect(keys.count == 1 && UUID(uuidString: keys[0]) != nil)
	}

	@Test("a plain sign-in never queues the first-use screen")
	func signInIsNotFirstUse() async {
		struct Login: Authenticating {
			func login(email: String, password: String) async throws -> LoginResult { created.login }
		}
		let firstUse = InMemoryFirstUseStore()
		let auth = AuthSession(authenticator: Login(), store: InMemorySecretStore(), firstUse: firstUse)
		await auth.signIn(email: "sam@example.com", password: secret)
		#expect(auth.session != nil)
		#expect(!firstUse.isPending(actorId: "actor-9"))
	}

	@Test("a taken email leaves the user signed out with nothing stored")
	func emailTaken() async throws {
		let (auth, store, firstUse, _) = make(.failure(SignUpError.emailTaken))
		await auth.signUp(name: "Sam", email: "sam@example.com", password: secret)
		#expect(auth.state == .signedOut)
		#expect(auth.lastSignUpError == .emailTaken)
		#expect(try store.read() == nil)
		#expect(!firstUse.isPending(actorId: "actor-9"))
	}

	@Test("every failure is kept as the typed error", arguments: [
		SignUpError.invalid(fields: ["password": "Too short"]), .rateLimited, .server(status: 502),
		.network("offline"),
	])
	func failures(_ error: SignUpError) async throws {
		let (auth, store, _, _) = make(.failure(error))
		await auth.signUp(name: "Sam", email: "sam@example.com", password: secret)
		#expect(auth.lastSignUpError == error)
		#expect(auth.state == .signedOut)
		#expect(try store.read() == nil)
	}

	@Test("an unexpected thrown error becomes a network error")
	func unexpected() async {
		struct Boom: Error {}
		let (auth, _, _, _) = make(.failure(Boom()))
		await auth.signUp(name: "Sam", email: "sam@example.com", password: secret)
		guard case .network? = auth.lastSignUpError else {
			Issue.record("expected .network, got \(String(describing: auth.lastSignUpError))")
			return
		}
	}

	@Test("workspace_provisioning_failed is a success: signed in, key saved, flag raised")
	func provisioningFailed() async throws {
		var result = created
		result.login.workspaceId = nil
		result.workspaceProvisioningFailed = true
		let (auth, store, firstUse, _) = make(.success(result))
		await auth.signUp(name: "Sam", email: "sam@example.com", password: secret)
		#expect(auth.session?.apiKey == "ank_new")
		#expect(auth.session?.workspaceId == nil)
		#expect(auth.workspaceProvisioningFailed)
		#expect(auth.lastSignUpError == nil)
		#expect(try store.read() != nil)
		#expect(firstUse.isPending(actorId: "actor-9"))
	}

	@Test("a second sign-up while one is running is ignored")
	func reentrancy() async {
		let (auth, _, _, fake) = make(.success(created))
		async let a: Void = auth.signUp(name: "Sam", email: "sam@example.com", password: secret)
		async let b: Void = auth.signUp(name: "Sam", email: "sam@example.com", password: secret)
		_ = await (a, b)
		#expect(fake.recorder.keys.withLock { $0.count } == 1)
	}

	@Test("no credential appears in any error's text or description")
	func noCredentialsInText() {
		let errors: [SignUpError] = [
			.emailTaken, .invalid(fields: ["email": "Invalid email"]), .rateLimited, .server(status: 500),
			.network("The Internet connection appears to be offline."),
		]
		for error in errors {
			#expect(!String(describing: error).contains(secret))
			#expect(!String(reflecting: error).contains(secret))
		}
	}

	@Test("first-use pending is per actor and clears when seen")
	func firstUseStore() {
		let store = InMemoryFirstUseStore()
		store.markPending(actorId: "a")
		#expect(store.isPending(actorId: "a") && !store.isPending(actorId: "b"))
		store.markSeen(actorId: "a")
		#expect(!store.isPending(actorId: "a"))

		let defaults = UserDefaults(suiteName: "firstuse-\(UUID().uuidString)")!
		let persisted = UserDefaultsFirstUseStore(defaults: defaults)
		persisted.markPending(actorId: "a")
		#expect(UserDefaultsFirstUseStore(defaults: defaults).isPending(actorId: "a"))
		persisted.markSeen(actorId: "a")
		#expect(!persisted.isPending(actorId: "a"))
	}
}

// MARK: - APIAuthenticator over a fake transport

private final class ScriptedTransport: ClientTransport, @unchecked Sendable {
	struct Seen { var path: String; var headers: HTTPFields; var body: String }
	private let lock = NSLock()
	private var _seen: [Seen] = []
	var seen: [Seen] { lock.withLock { _seen } }
	let status: Int
	let json: String

	init(status: Int, json: String) {
		self.status = status
		self.json = json
	}

	func send(_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String) async throws
		-> (HTTPResponse, HTTPBody?)
	{
		var text = ""
		if let body { text = String(decoding: try await Data(collecting: body, upTo: 1_000_000), as: UTF8.self) }
		lock.withLock {
			_seen.append(Seen(path: request.path ?? "", headers: request.headerFields, body: text))
		}
		var response = HTTPResponse(status: .init(code: status))
		response.headerFields[.contentType] = "application/json"
		return (response, HTTPBody(json))
	}
}

private func authenticator(_ transport: ScriptedTransport) -> APIAuthenticator {
	APIAuthenticator(
		client: Client(
			serverURL: URL(string: "http://localhost:3000")!, transport: transport,
			middlewares: [IdempotencyMiddleware()]))
}

private let createdJSON = """
	{"id":"11111111-1111-1111-1111-111111111111","type":"human","name":"Sam","email":"sam@example.com",
	"description":null,"system_prompt":null,"tools":null,"memory":null,"llm_provider":null,"llm_config":null,
	"isSystem":false,"agentState":"idle","agentStateUpdatedAt":null,"createdAt":"2026-10-02T00:00:00Z",
	"updatedAt":"2026-10-02T00:00:00Z","api_key":"ank_new","workspace_id":"ws-9"}
	"""

@Suite("APIAuthenticator sign-up")
struct APISignUpTests {
	@Test("201 maps to a session and sends a human, the Idempotency-Key and the credentials once")
	func created201() async throws {
		let transport = ScriptedTransport(status: 201, json: createdJSON)
		let result = try await authenticator(transport).signUp(
			name: "Sam", email: "sam@example.com", password: secret, idempotencyKey: "key-1")

		#expect(result.login.apiKey == "ank_new")
		#expect(result.login.workspaceId == "ws-9")
		#expect(!result.workspaceProvisioningFailed)
		let sent = try #require(transport.seen.first)
		#expect(sent.path == "/api/actors")
		#expect(sent.headers[IdempotencyMiddleware.header] == "key-1")
		let body = try #require(
			JSONSerialization.jsonObject(with: Data(sent.body.utf8)) as? [String: Any])
		#expect(body["type"] as? String == "human")
		#expect(body["email"] as? String == "sam@example.com")
	}

	@Test("workspace_provisioning_failed is carried through")
	func provisioning() async throws {
		let json = createdJSON.replacingOccurrences(
			of: "\"workspace_id\":\"ws-9\"", with: "\"workspace_provisioning_failed\":true")
		let result = try await authenticator(ScriptedTransport(status: 201, json: json)).signUp(
			name: "Sam", email: "sam@example.com", password: secret, idempotencyKey: "k")
		#expect(result.workspaceProvisioningFailed)
		#expect(result.login.workspaceId == nil)
	}

	@Test("409 is a taken email")
	func conflict() async {
		let json = #"{"error":{"code":"CONFLICT","message":"Email already exists"}}"#
		await #expect(throws: SignUpError.emailTaken) {
			try await authenticator(ScriptedTransport(status: 409, json: json)).signUp(
				name: "Sam", email: "sam@example.com", password: secret, idempotencyKey: "k")
		}
	}

	@Test("400 maps each detail to its field")
	func badRequest() async {
		let json = """
			{"error":{"code":"VALIDATION_ERROR","message":"Request validation failed","details":[
			{"field":"password","message":"String must contain at least 8 character(s)"},
			{"field":"email","message":"Invalid email"}]}}
			"""
		await #expect(
			throws: SignUpError.invalid(fields: [
				"password": "String must contain at least 8 character(s)", "email": "Invalid email",
			])
		) {
			try await authenticator(ScriptedTransport(status: 400, json: json)).signUp(
				name: "Sam", email: "sam", password: "x", idempotencyKey: "k")
		}
	}

	@Test("429 is rate limited and 5xx is a server error")
	func otherStatuses() async {
		await #expect(throws: SignUpError.rateLimited) {
			try await authenticator(ScriptedTransport(status: 429, json: "{}")).signUp(
				name: "S", email: "s@e.co", password: secret, idempotencyKey: "k")
		}
		await #expect(throws: SignUpError.server(status: 500)) {
			try await authenticator(ScriptedTransport(status: 500, json: #"{"error":{"code":"INTERNAL_ERROR","message":"Internal error"}}"#)).signUp(
				name: "S", email: "s@e.co", password: secret, idempotencyKey: "k")
		}
	}

	@Test("a transport failure is a network error that doesn't echo the password")
	func transportFails() async {
		struct Down: ClientTransport {
			func send(_ r: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String) async throws
				-> (HTTPResponse, HTTPBody?)
			{ throw URLError(.notConnectedToInternet) }
		}
		let auth = APIAuthenticator(
			client: Client(serverURL: URL(string: "http://localhost:3000")!, transport: Down()))
		do {
			_ = try await auth.signUp(name: "S", email: "s@e.co", password: secret, idempotencyKey: "k")
			Issue.record("expected a throw")
		} catch let error as SignUpError {
			guard case .network(let text) = error else {
				Issue.record("wrong case")
				return
			}
			#expect(!text.contains(secret))
		} catch { Issue.record("wrong error type") }
	}

	@Test("field messages keep the first per field and drop blanks")
	func fieldMessages() {
		let folded = SignUpError.fieldMessages([("email", "A"), ("email", "B"), ("name", "")])
		#expect(folded == ["email": "A"])
	}
}
