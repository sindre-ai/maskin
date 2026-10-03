import Foundation
import MaskinCore
import Testing

@testable import MaskinFeatures

private let pw = "correct-horse-battery"

private struct Scripted: Authenticating {
	var signUpResult: Result<SignUpResult, SignUpError>
	var loginResult: Result<LoginResult, AuthError> = .failure(.invalidCredentials)
	func login(email: String, password: String) async throws -> LoginResult { try loginResult.get() }
	func signUp(name: String, email: String, password: String, idempotencyKey: String) async throws
		-> SignUpResult
	{ try signUpResult.get() }
}

private let ok = SignUpResult(
	login: LoginResult(apiKey: "ank_new", actorId: "a-1", name: "Sam", email: "sam@example.com", workspaceId: "ws-1"))

@MainActor
private func session(_ result: Result<SignUpResult, SignUpError>) -> AuthSession {
	AuthSession(
		authenticator: Scripted(signUpResult: result), store: InMemorySecretStore(),
		firstUse: InMemoryFirstUseStore())
}

@Suite("SignUpForm")
struct SignUpFormTests {
	@Test("needs a name, a plausible email and 8+ characters")
	func rules() {
		var f = SignUpForm()
		#expect(!f.canSubmit)
		f.name = "Sam"
		f.email = "sam@example.com"
		f.password = "1234567"
		#expect(f.passwordProblem != nil && !f.canSubmit)
		f.password = "12345678"
		#expect(f.canSubmit)
	}

	@Test("email shape matches what the server accepts", arguments: [
		("a@b.co", true), ("a@b", false), ("a b@c.de", false), ("@b.co", false), ("a@.co", false),
		("a@b..co", false), ("", false),
	])
	func email(_ value: String, _ valid: Bool) {
		#expect(SignUpForm.looksLikeEmail(value) == valid)
	}

	@Test("a whitespace-only name is empty")
	func blankName() {
		#expect(SignUpForm(name: "   ", email: "a@b.co", password: "12345678").nameProblem != nil)
	}

	@Test("every sign-up error has plain copy that hides internals")
	func messages() {
		#expect(SignUpError.emailTaken.message.hasPrefix("Email already exists"))
		#expect(SignUpError.rateLimited.message.contains("Too many"))
		#expect(SignUpError.server(status: 502).message.contains("502"))
		#expect(!SignUpError.network("NSURLErrorDomain -1009").message.contains("NSURL"))
	}
}

@Suite("AuthConfig")
struct AuthConfigTests {
	@Test("sign-up defaults on when the key is absent")
	func defaults() {
		#expect(AuthConfig(info: nil).signUpEnabled)
		#expect(AuthConfig(info: [:]).signUpEnabled)
	}

	@Test("MaskinEnableSignUp turns it off as a Bool or a string")
	func off() {
		#expect(!AuthConfig(info: ["MaskinEnableSignUp": false]).signUpEnabled)
		#expect(!AuthConfig(info: ["MaskinEnableSignUp": "NO"]).signUpEnabled)
		#expect(AuthConfig(info: ["MaskinEnableSignUp": true]).signUpEnabled)
		#expect(AuthConfig(info: ["MaskinEnableSignUp": "YES"]).signUpEnabled)
	}

	@Test("legal links must be https; nothing is invented when missing")
	func links() {
		let c = AuthConfig(info: ["MaskinTermsURL": "https://example.com/t", "MaskinPrivacyURL": "javascript:alert(1)"])
		#expect(c.termsURL?.absoluteString == "https://example.com/t")
		#expect(c.privacyURL == nil)
		#expect(AuthConfig(info: [:]).termsURL == nil)
	}
}

@MainActor
@Suite("AuthScreenModel")
struct AuthScreenModelTests {
	@Test("starts on sign-in; switching carries email and password, clears hints")
	func switching() {
		let m = AuthScreenModel(config: AuthConfig())
		#expect(m.mode == .signIn && m.fields == [.email, .password])
		m.email = "sam@example.com"
		m.switchTo(.createAccount)
		#expect(m.mode == .createAccount && m.fields == [.name, .email, .password])
		#expect(m.email == "sam@example.com")
		#expect(m.next(after: .name) == .email && m.next(after: .password) == nil)
	}

	@Test("with sign-up disabled the screen can never leave sign-in")
	func disabled() {
		let m = AuthScreenModel(mode: .createAccount, config: AuthConfig(signUpEnabled: false))
		#expect(m.mode == .signIn)
		m.switchTo(.createAccount)
		#expect(m.mode == .signIn)
	}

	@Test("live hints appear only for fields the user has visited")
	func liveHints() {
		let m = AuthScreenModel(mode: .createAccount, config: AuthConfig())
		#expect(m.message(for: .email) == nil)
		m.email = "nope"
		#expect(m.message(for: .email) == nil)
		m.touch(.email)
		#expect(m.message(for: .email) != nil)
		m.email = "a@b.co"
		#expect(m.message(for: .email) == nil)
	}

	@Test("submit with an invalid form sends nothing and reveals every hint")
	func invalidSubmit() async {
		let auth = session(.success(ok))
		let m = AuthScreenModel(mode: .createAccount, config: AuthConfig())
		let sent = await m.submit(auth: auth)
		#expect(!sent && auth.session == nil)
		#expect(m.message(for: .name) != nil && m.message(for: .password) != nil)
	}

	@Test("a successful sign-up signs in")
	func success() async {
		let auth = session(.success(ok))
		let m = AuthScreenModel(mode: .createAccount, config: AuthConfig())
		m.name = " Sam "
		m.email = "sam@example.com"
		m.password = pw
		#expect(await m.submit(auth: auth))
		#expect(auth.session?.apiKey == "ank_new")
		#expect(m.banner(for: auth) == nil)
	}

	@Test("409 puts 'Email already exists' on the email field and no banner")
	func emailTaken() async {
		let auth = session(.failure(.emailTaken))
		let m = AuthScreenModel(mode: .createAccount, config: AuthConfig())
		m.name = "Sam"; m.email = "sam@example.com"; m.password = pw
		await m.submit(auth: auth)
		#expect(m.message(for: .email) == "Email already exists.")
		#expect(m.banner(for: auth) == nil)
		m.email = "sam2@example.com"
		#expect(m.message(for: .email) == nil)
	}

	@Test("400 details land on their own fields; unknown fields fall back to the banner")
	func perField() async {
		let auth = session(.failure(.invalid(fields: ["password": "Too short"])))
		let m = AuthScreenModel(mode: .createAccount, config: AuthConfig())
		m.name = "Sam"; m.email = "sam@example.com"; m.password = pw
		await m.submit(auth: auth)
		#expect(m.message(for: .password) == "Too short")
		#expect(m.banner(for: auth) == nil)

		let other = session(.failure(.invalid(fields: ["tools": "Bad"])))
		let m2 = AuthScreenModel(mode: .createAccount, config: AuthConfig())
		m2.name = "Sam"; m2.email = "sam@example.com"; m2.password = pw
		await m2.submit(auth: other)
		#expect(m2.banner(for: other) == .error("Bad"))
	}

	@Test("network and rate-limit errors show as a banner")
	func banners() async {
		for (error, text) in [(SignUpError.network("x"), "Can't reach"), (.rateLimited, "Too many")] {
			let auth = session(.failure(error))
			let m = AuthScreenModel(mode: .createAccount, config: AuthConfig())
			m.name = "Sam"; m.email = "sam@example.com"; m.password = pw
			await m.submit(auth: auth)
			guard case .error(let shown)? = m.banner(for: auth) else {
				Issue.record("no banner"); continue
			}
			#expect(shown.contains(text))
		}
	}

	@Test("sign-in: a session-ended notice is calm, and a real error replaces it")
	func signInBanner() async {
		let auth = AuthSession(
			authenticator: Scripted(signUpResult: .success(ok), loginResult: .failure(.invalidCredentials)),
			store: InMemorySecretStore(), firstUse: InMemoryFirstUseStore())
		let m = AuthScreenModel(config: AuthConfig())
		#expect(m.banner(for: auth) == nil)
		m.email = "sam@example.com"; m.password = "x"
		await m.submit(auth: auth)
		guard case .error(let text)? = m.banner(for: auth) else {
			Issue.record("no error")
			return
		}
		#expect(text.contains("don't match"))
	}

	@Test("the session-ended notice shows on a fresh sign-in screen")
	func sessionEnded() async {
		let store = InMemorySecretStore()
		let auth = AuthSession(
			authenticator: Scripted(signUpResult: .success(ok), loginResult: .success(ok.login)), store: store)
		await auth.signIn(email: "a@b.co", password: "x")
		auth.sessionRejected(apiKey: "ank_new")
		let m = AuthScreenModel(config: AuthConfig())
		#expect(m.banner(for: auth) == .notice(LoginForm.sessionEndedMessage))
	}
}

@Suite("FirstUse")
struct FirstUseTests {
	@Test("three beats, in order, with copy")
	func beats() {
		#expect(FirstUseBeat.all.map(\.id) == [1, 2, 3])
		#expect(FirstUseBeat.all.allSatisfy { !$0.title.isEmpty && !$0.detail.isEmpty })
	}

	@Test("readiness: only a failed provisioning with no workspace asks to retry")
	func readiness() {
		typealias R = FirstUseReadiness
		#expect(R.resolve(provisioningFailed: false, workspaceCount: 0, isLoading: false) == .ready)
		#expect(R.resolve(provisioningFailed: true, workspaceCount: 1, isLoading: false) == .ready)
		#expect(R.resolve(provisioningFailed: true, workspaceCount: 0, isLoading: false) == .settingUp)
		#expect(R.resolve(provisioningFailed: true, workspaceCount: 0, isLoading: true) == .retrying)
	}
}
