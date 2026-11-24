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
		#expect(message(.object(["mcp_server_request": .object([:])])).asksForAnswer)
		#expect(message(.object(["integration_connect": .object([:])])).asksForAnswer == false)
		#expect(message(nil).asksForAnswer == false)
	}

	@Test func askingAgainNamesWhatWasDeclined() {
		let m = message(
			.object([
				"integration_access_request": .object([
					"session_id": .string("s"), "integration_id": .string("i"), "display_name": .string("Gmail"),
					"level": .string("read"),
				])
			]))
		#expect(IntegrationAccessRequest(message: m)?.askAgainText.contains("Gmail") == true)
	}
}

@Suite("Integration access card copy")
struct IntegrationAccessCopyTests {
	private func request(level: String) throws -> IntegrationAccessRequest {
		let m = ChatMessage(
			id: "1", conversationID: "c", actorID: "a", actorName: "Chief", author: .agent, content: "x",
			metadata: .object([
				"integration_access_request": .object([
					"session_id": .string("s"), "integration_id": .string("i"), "display_name": .string("Gmail"),
					"level": .string(level),
				])
			]))
		return try #require(IntegrationAccessRequest(message: m))
	}

	@Test func readWriteAskCanBeLoweredButReadCannotBeRaised() throws {
		#expect(try request(level: "read_write").choosableLevels == [.read, .readWrite])
		#expect(try request(level: "read").choosableLevels == [.read])
	}

	@Test func lowerLevelChangesTheReplyWords() throws {
		let lowered = try request(level: "read_write").with(level: .read)
		#expect(lowered.allowedReply(changed: true).contains("read access to Gmail"))
	}

	@Test func settledLinesNameTheAgent() throws {
		let r = try request(level: "read")
		#expect(r.allowedLine(agentName: "Chief of Staff") == "Allowed Gmail for Chief of Staff.")
		#expect(r.declinedLine(agentName: nil) == "Declined Gmail for this agent.")
	}
}

@Suite("Integration access card, allow in this chat")
struct IntegrationAccessChatLiftTests {
	private func request(level: String, lift: JSONValue? = nil, reason: String? = "To add the Meet link.", helper: Bool = false) throws
		-> IntegrationAccessRequest
	{
		var raw: [String: JSONValue] = [
			"session_id": .string("s"), "integration_id": .string("i"), "display_name": .string("Google Calendar"),
			"level": .string(level),
		]
		if let reason { raw["reason"] = .string(reason) }
		if let lift { raw["chat_lift"] = lift }
		if helper { raw["reply_to_session"] = .bool(true) }
		let m = ChatMessage(
			id: "1", conversationID: "c", actorID: "a", actorName: "Chief", author: .agent, content: "x",
			metadata: .object(["integration_access_request": .object(raw)]))
		return try #require(IntegrationAccessRequest(message: m))
	}

	private let lift: JSONValue = .object([
		"hours": .number(8), "text": .string("Lets it create and change events for 8 hours."), "tool": .string("create_event"),
	])

	@Test func theServersOfferIsReadWithItsFixedTextAndTool() throws {
		let r = try request(level: "read_write", lift: lift)
		#expect(r.lift == .init(hours: 8, text: "Lets it create and change events for 8 hours.", tool: "create_event"))
		#expect(r.reason == "To add the Meet link.")
	}

	@Test func noOfferWithoutTheServersLiftOrForAReadAsk() throws {
		#expect(try request(level: "read_write").lift == nil)
		#expect(try request(level: "read", lift: lift).lift == nil)
	}

	@Test func anOfferWithoutHoursOrTextIsIgnored() throws {
		#expect(try request(level: "read_write", lift: .object(["hours": .number(0), "text": .string("x")])).lift == nil)
		#expect(try request(level: "read_write", lift: .object(["hours": .number(8)])).lift == nil)
	}

	@Test func theToolIsOptional() throws {
		let r = try request(level: "read_write", lift: .object(["hours": .number(8), "text": .string("t")]))
		#expect(r.lift?.tool == nil)
	}

	@Test func theChatReplyNamesTheHoursAndTheChat() throws {
		let r = try request(level: "read_write", lift: lift)
		#expect(
			r.chatAllowedReply()
				== "I've allowed you read and write access to Google Calendar for the next 8 hours, in this chat only. Carry on with the work. Reply with one short line to say you have it."
		)
		#expect(try request(level: "read_write", lift: lift, helper: true).chatAllowedReply().hasSuffix("Carry on with the work."))
	}

	@Test func theSettledLineSaysInThisChatForTheHours() throws {
		let r = try request(level: "read_write", lift: lift)
		#expect(r.chatAllowedLine(agentName: "Chief of Staff") == "Allowed Google Calendar for Chief of Staff in this chat for 8 hours.")
	}

	@Test func notNowWaitsThreeSecondsAtMost() {
		#expect(integrationDeclineTimeout == .seconds(3))
	}
}
