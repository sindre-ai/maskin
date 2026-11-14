import MaskinCore
import Testing

@testable import MaskinFeatures

@MainActor
@Suite("ForgotPasswordModel")
struct ForgotPasswordModelTests {
	private final class Sent: @unchecked Sendable {
		var emails: [String] = []
	}

	@Test("needs a plausible email")
	func canSubmit() {
		let model = ForgotPasswordModel { _ in }
		#expect(!model.canSubmit)
		model.email = "alex"
		#expect(!model.canSubmit)
		model.email = "  alex@example.com \n"
		#expect(model.canSubmit)
		#expect(model.trimmedEmail == "alex@example.com")
	}

	@Test("sends the trimmed email and shows the neutral message")
	func sends() async {
		let sent = Sent()
		let model = ForgotPasswordModel(email: " alex@example.com ") { sent.emails.append($0) }

		await model.submit()

		#expect(sent.emails == ["alex@example.com"])
		#expect(model.phase == .sent)
		#expect(ForgotPasswordModel.sentMessage == "If that email has an account, we sent a link.")
	}

	@Test("does not send twice once sent")
	func onlyOnce() async {
		let sent = Sent()
		let model = ForgotPasswordModel(email: "alex@example.com") { sent.emails.append($0) }

		await model.submit()
		await model.submit()

		#expect(sent.emails.count == 1)
	}

	@Test("a failed send shows plain copy and editing the email clears it")
	func failure() async {
		let model = ForgotPasswordModel(email: "alex@example.com") { _ in
			throw PasswordResetError.rateLimited
		}

		await model.submit()
		#expect(model.phase == .failed(PasswordResetError.rateLimited.message))

		model.email = "alex@example.org"
		#expect(model.phase == .editing)
	}

	@Test("every error has user-facing copy that hides internals")
	func messages() {
		#expect(PasswordResetError.server(status: 503).message.contains("503"))
		#expect(!PasswordResetError.network("NSURLErrorDomain -1009").message.contains("NSURL"))
		#expect(PasswordResetError.network("x").message.contains("connection"))
		#expect(PasswordResetError.rateLimited.message.contains("Too many"))
	}
}
