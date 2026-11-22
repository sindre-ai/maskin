import Foundation
import Testing

@testable import MaskinCore

@Suite("SignupCapture")
struct SignupCaptureTests {
	@Test("the capture asks the server to open the welcome chat, as the web sign-up does")
	func welcomeInChat() throws {
		let capture = try #require(SignupCapture(name: "Sam", organization: "Acme", role: "Founder"))
		let metadata = capture.metadata()
		#expect(metadata["welcome_in_chat"] as? Bool == true)
		#expect(metadata["source"] as? String == SignupCapture.source)
		#expect(metadata["name"] as? String == "Sam")
	}

	@Test("a blank field means no capture")
	func blankField() {
		#expect(SignupCapture(name: "Sam", organization: " ", role: "Founder") == nil)
	}
}
