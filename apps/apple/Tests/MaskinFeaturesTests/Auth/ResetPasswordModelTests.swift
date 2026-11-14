import Foundation
import MaskinCore
import Testing

@testable import MaskinFeatures

@MainActor
@Suite("ResetPasswordModel")
struct ResetPasswordModelTests {
	private final class Sent: @unchecked Sendable {
		var calls: [(token: String, password: String)] = []
	}

	@Test("needs both fields before it can be sent")
	func canSubmit() {
		let model = ResetPasswordModel(token: "rst_token") { _, _ in }
		#expect(!model.canSubmit)
		model.password = "correct horse"
		#expect(!model.canSubmit)
		model.confirmation = "correct horse"
		#expect(model.canSubmit)
	}

	@Test("a short password is refused before anything is sent")
	func tooShort() async {
		let sent = Sent()
		let model = ResetPasswordModel(token: "rst_token") { sent.calls.append(($0, $1)) }
		model.password = "short"
		model.confirmation = "short"

		await model.submit()

		#expect(sent.calls.isEmpty)
		#expect(model.phase == .failed(ResetPasswordModel.tooShortMessage))
	}

	@Test("a mismatch is refused before anything is sent")
	func mismatch() async {
		let sent = Sent()
		let model = ResetPasswordModel(token: "rst_token") { sent.calls.append(($0, $1)) }
		model.password = "correct horse"
		model.confirmation = "correct horsf"

		await model.submit()

		#expect(sent.calls.isEmpty)
		#expect(model.phase == .failed(ResetPasswordModel.mismatchMessage))
	}

	@Test("sends the link's token with the new password, then is done")
	func sends() async {
		let sent = Sent()
		let model = ResetPasswordModel(token: "rst_token") { sent.calls.append(($0, $1)) }
		model.password = "correct horse"
		model.confirmation = "correct horse"

		await model.submit()

		#expect(sent.calls.count == 1)
		#expect(sent.calls[0].token == "rst_token")
		#expect(sent.calls[0].password == "correct horse")
		#expect(model.phase == .done)
	}

	@Test("does not send twice once done")
	func onlyOnce() async {
		let sent = Sent()
		let model = ResetPasswordModel(token: "rst_token") { sent.calls.append(($0, $1)) }
		model.password = "correct horse"
		model.confirmation = "correct horse"

		await model.submit()
		await model.submit()

		#expect(sent.calls.count == 1)
	}

	@Test("an expired link shows the web page's wording and editing clears it")
	func invalidLink() async {
		let model = ResetPasswordModel(token: "rst_token") { _, _ in throw PasswordResetError.invalidLink }
		model.password = "correct horse"
		model.confirmation = "correct horse"

		await model.submit()
		#expect(model.problem == "This reset link is invalid or has expired. Ask for a new one.")

		model.confirmation = "correct horsf"
		#expect(model.phase == .editing)
	}

	@Test("an unexpected error shows plain copy that hides internals")
	func unexpected() async {
		struct Boom: Error, LocalizedError { var errorDescription: String? { "NSURLErrorDomain -1009" } }
		let model = ResetPasswordModel(token: "rst_token") { _, _ in throw Boom() }
		model.password = "correct horse"
		model.confirmation = "correct horse"

		await model.submit()

		#expect(model.problem?.contains("NSURL") == false)
		#expect(model.problem?.contains("connection") == true)
	}
}
