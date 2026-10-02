import MaskinCore
import Testing

@testable import MaskinFeatures

@Suite("LoginForm")
struct LoginFormTests {
	@Test("needs a plausible email and a password")
	func canSubmit() {
		var form = LoginForm()
		#expect(!form.canSubmit)
		form.email = "alex@example.com"
		#expect(!form.canSubmit)
		form.password = "pw"
		#expect(form.canSubmit)
		form.email = "alex"
		#expect(!form.canSubmit)
		form.email = "  alex@example.com \n"
		#expect(form.canSubmit)
		#expect(form.trimmedEmail == "alex@example.com")
	}

	@Test("every AuthError has user-facing copy that hides internals")
	func messages() {
		#expect(AuthError.invalidCredentials.message.contains("don't match"))
		#expect(AuthError.server(status: 503).message.contains("503"))
		#expect(!AuthError.network("NSURLErrorDomain -1009").message.contains("NSURL"))
	}
}
