import Foundation
import Testing

@testable import MaskinCore

@Suite("Agent intro")
struct AgentIntroTests {
	private func message(_ metadata: JSONValue?, author: ChatParticipant.Kind = .agent, content: String = "x") -> ChatMessage {
		ChatMessage(
			id: "1", conversationID: "c", actorID: "a", actorName: "Rep", author: author, kind: "message",
			content: content, metadata: metadata)
	}

	private func step(_ label: String, _ prompt: String? = nil, _ action: String = "send") -> JSONValue {
		.object(["label": .string(label), "prompt": .string(prompt ?? label), "action": .string(action)])
	}

	private func intro(steps: [JSONValue]? = nil, tools: [String]? = nil, tail: JSONValue? = .number(2)) -> JSONValue {
		var o: [String: JSONValue] = [:]
		if let steps { o["suggested_steps"] = .array(steps) }
		if let tools { o["needed_tools"] = .array(tools.map { .object(["provider": .string($0)]) }) }
		if let tail { o["plain_tail"] = tail }
		return .object(o)
	}

	@Test func readsStepsToolsAndTail() throws {
		let m = message(intro(steps: [step("Set up my pages"), step("Draft a post", "Draft a post about…", "fill")], tools: ["slack"]))
		let view = try #require(AgentIntroView(message: m))
		#expect(view.steps?.map(\.label) == ["Set up my pages", "Draft a post"])
		#expect(view.steps?.map(\.sends) == [true, false])
		#expect(view.steps?[1].prompt == "Draft a post about…")
		#expect(view.tools == ["slack"])
		#expect(view.plainTail == 2)
	}

	@Test func aMessageWithNoIntroKeysOrFromAPersonIsNotAnIntro() {
		#expect(AgentIntroView(message: message(.object(["mentions": .array([])]))) == nil)
		#expect(AgentIntroView(message: message(intro(steps: [step("Go")]), author: .human)) == nil)
		#expect(AgentIntroView(message: message(nil)) == nil)
	}

	@Test func anyBadKeyDropsTheWholeIntroSoTheBodyShowsInFull() {
		#expect(AgentIntroView(message: message(intro(steps: []))) == nil)
		#expect(AgentIntroView(message: message(intro(steps: Array(repeating: step("a"), count: 5)))) == nil)
		#expect(AgentIntroView(message: message(intro(steps: [step("Go", "Something else", "send")]))) == nil)
		#expect(AgentIntroView(message: message(intro(steps: [step("Go", "Go ", "send")]))) == nil)
		#expect(AgentIntroView(message: message(intro(steps: [step("Go", nil, "shout")]))) == nil)
		#expect(AgentIntroView(message: message(intro(steps: [step(String(repeating: "a", count: 61))]))) == nil)
		#expect(AgentIntroView(message: message(intro(tools: ["a", "b", "c", "d"]))) == nil)
		#expect(AgentIntroView(message: message(intro(steps: [step("Go")], tail: nil))) == nil)
		#expect(AgentIntroView(message: message(intro(steps: [step("Go")], tail: .number(-1)))) == nil)
	}

	@Test func dropsTheTrailingParagraphsTheButtonsReplace() {
		let body = "Hi, I'm the rep.\n\n- one\n- two\n\nTools: Slack\n\nWhere do you want to start?"
		#expect(AgentIntroView.dropPlainTail(body, count: 3) == "Hi, I'm the rep.")
		#expect(AgentIntroView.dropPlainTail(body, count: 1).hasSuffix("Tools: Slack"))
		#expect(AgentIntroView.dropPlainTail(body, count: 0) == body)
	}

	@Test func aWrongCountCanOnlyShowTooMuchNeverCutTheGreeting() {
		let body = "Hi.\n\nBye."
		#expect(AgentIntroView.dropPlainTail(body, count: 2) == body)
		#expect(AgentIntroView.dropPlainTail(body, count: 9) == body)
	}

	@Test func theMessageTextLosesItsTailOnlyForAnIntro() {
		let body = "Hi.\n\nPlain list\n\nClosing."
		#expect(message(intro(steps: [step("Go")], tail: .number(2)), content: body).contentWithoutIntroTail == "Hi.")
		#expect(message(nil, content: body).contentWithoutIntroTail == body)
	}

	@Test func theStepATapCameFromGoesOnTheWire() throws {
		let metadata = ChatSendMetadata(fromSuggestedStep: ChatSuggestedStepRef(introMessageID: 12, index: 2))
		let json = try #require(metadata.jsonValue)
		#expect(json["from_suggested_step"]?["intro_message_id"]?.intValue == 12)
		#expect(json["from_suggested_step"]?["index"]?.intValue == 2)
	}
}
