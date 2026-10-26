import Foundation
import Testing

@testable import MaskinCore

@Suite("Agent request cards")
struct AgentRequestCardsTests {
	private func message(_ metadata: JSONValue?) -> ChatMessage {
		ChatMessage(
			id: "1", conversationID: "c", actorID: "a", actorName: "Infra", author: .agent, kind: "message",
			content: "x", metadata: metadata)
	}

	@Test func readsAConnectRequest() throws {
		let m = message(.object(["integration_connect": .object(["session_id": .string("s"), "provider": .string("linear")])]))
		#expect(try #require(IntegrationConnectRequest(message: m)).provider == "linear")
		#expect(IntegrationConnectRequest(message: message(nil)) == nil)
	}

	@Test func readsAComputerRequestAndItsDoneMessage() throws {
		let m = message(
			.object([
				"computer_request": .object([
					"session_id": .string("s"), "task": .string("Enter the 2FA code"), "reply_to_session": .bool(true),
				])
			]))
		let request = try #require(ComputerRequest(message: m))
		#expect(request.task == "Enter the 2FA code")
		#expect(request.replyToSession)
		#expect(ComputerRequest.doneMessage == "Done: I've finished on the computer. Please take a screenshot and carry on.")
	}

	@Test func readsAnAccessRequestAndWordsItLikeTheWeb() throws {
		let m = message(
			.object([
				"integration_access_request": .object([
					"session_id": .string("s"), "integration_id": .string("i"), "provider": .string("slack"),
					"display_name": .string("Slack"), "level": .string("read_write"), "reason": .string("To post the update."),
				])
			]))
		let request = try #require(IntegrationAccessRequest(message: m))
		#expect(request.level == .readWrite)
		#expect(request.allowedReply(changed: true) == "I've allowed you read and write access to Slack. Carry on with the work. Reply with one short line to say you have it.")
		#expect(request.allowedReply(changed: false) == "You already have read and write access to Slack. Carry on with the work. Reply with one short line to say you have it.")
		#expect(request.declinedReply == "Not now: please don't use Slack yet. Carry on without it, or tell me what you need instead.")
	}

	@Test func aHelperIsToldToCarryOnWithoutAskingForAReplyLine() throws {
		let m = message(
			.object([
				"integration_access_request": .object([
					"session_id": .string("s"), "integration_id": .string("i"), "display_name": .string("Slack"),
					"level": .string("read"), "reply_to_session": .bool(true),
				])
			]))
		let request = try #require(IntegrationAccessRequest(message: m))
		#expect(request.allowedReply(changed: true) == "I've allowed you read access to Slack. Carry on with the work.")
	}

	@Test func theServersReasonIsShownInsteadOfTryAgain() {
		#expect(APIIntegrationAccessSource.refusal("Use read_write or none for this tool.") == "Couldn't allow: Use read_write or none for this tool.")
		#expect(APIIntegrationAccessSource.refusal(nil) == "Couldn't allow it. Try again.")
	}

	@Test func anAccessRequestNeedsAKnownLevel() {
		let m = message(
			.object([
				"integration_access_request": .object([
					"session_id": .string("s"), "integration_id": .string("i"), "display_name": .string("Slack"),
					"level": .string("admin"),
				])
			]))
		#expect(IntegrationAccessRequest(message: m) == nil)
	}

	@Test func onlyCardsThatRecordAnAnswerAskForOne() {
		#expect(message(.object(["computer_request": .object([:])])).asksForAnswer)
		#expect(message(.object(["integration_access_request": .object([:])])).asksForAnswer)
		#expect(message(.object(["integration_connect": .object([:])])).asksForAnswer == false)
		#expect(message(nil).asksForAnswer == false)
	}
}
