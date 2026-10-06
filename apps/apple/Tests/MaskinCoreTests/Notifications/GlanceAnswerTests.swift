import Foundation
import Testing

@testable import MaskinCore

private func action(_ style: AppNotification.Action.Style, response: JSONValue = .string("ok"))
	-> AppNotification.Action
{
	AppNotification.Action(id: "a", label: "Do it", response: response, style: style)
}

@Suite("GlanceAnswer")
struct GlanceAnswerTests {
	@Test("a primary or secondary option sends at once")
	func plainOptionsSend() {
		#expect(GlanceAnswer.step(for: action(.primary)) == .send(.string("ok")))
		#expect(GlanceAnswer.step(for: action(.secondary, response: .string("no"))) == .send(.string("no")))
	}

	@Test("a destructive option asks before it sends")
	func destructiveConfirms() {
		let destructive = action(.destructive)
		#expect(GlanceAnswer.step(for: destructive) == .confirm(destructive))
	}

	@Test("a reply is trimmed and sent as a string")
	func replyTrims() {
		#expect(GlanceAnswer.reply(from: "  looks good \n") == .string("looks good"))
	}

	@Test("a blank reply sends nothing")
	func blankReply() {
		#expect(GlanceAnswer.reply(from: "") == nil)
		#expect(GlanceAnswer.reply(from: " \n\t ") == nil)
	}

	@Test("the screen stays open while an error is showing")
	func dismissOnlyOnSuccess() {
		#expect(GlanceAnswer.shouldDismiss(actionError: nil))
		#expect(!GlanceAnswer.shouldDismiss(actionError: "Couldn't send"))
	}
}
