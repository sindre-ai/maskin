import Foundation
import Testing

@testable import MaskinCore

@Suite("Question options")
struct QuestionRecommendationTests {
	private func message(_ options: [JSONValue]) -> ChatMessage {
		chatMsg(
			1, by: "relay", agent: true, "Which?",
			metadata: .object([
				"question": .object([
					"questions": .array([
						.object([
							"header": .string("Env"), "question": .string("Which environment?"),
							"options": .array(options),
						])
					])
				])
			]))
	}

	@Test("a (Recommended) suffix marks the option and is stripped from the label sent back")
	func suffix() {
		let m = message([
			.object(["label": .string("Staging (Recommended)")]), .object(["label": .string("Prod")]),
		])
		let options = m.questions.first?.options
		#expect(options?.map(\.label) == ["Staging", "Prod"])
		#expect(options?.map(\.recommended) == [true, false])
	}

	@Test("an explicit recommended flag marks the option; a label that is only the marker is kept")
	func flag() {
		let m = message([
			.object(["label": .string("Hold"), "recommended": .bool(true)]),
			.object(["label": .string("(Recommended)")]),
		])
		let options = m.questions.first?.options
		#expect(options?.first?.recommended == true)
		#expect(options?.last?.label == "(Recommended)")
	}

	/// Shape produced by docker/agent-base/hooks/ask-user-question.sh (jq projection of the
	/// AskUserQuestion tool input): snake_case `multi_select`, `description` always present
	/// (possibly empty), label passed through verbatim - so the tool's own "(Recommended)"
	/// label convention is the only recommendation signal that reaches the stored message.
	@Test("a hook-shaped question: suffix stripped, empty description dropped, no flag field")
	func hookShapedFixture() throws {
		let json = """
			{"question":{"session_id":"11111111-1111-1111-1111-111111111111","questions":[
			{"question":"How should we access Spotify?","header":"Spotify access","multi_select":false,
			 "options":[{"label":"API token (Recommended)","description":"You create a developer app"},
			            {"label":"No login","description":""}]}]}}
			"""
		let metadata = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
		let q = chatMsg(1, by: "relay", agent: true, "Q", metadata: metadata).questions.first
		#expect(q?.options.map(\.label) == ["API token", "No login"])
		#expect(q?.options.map(\.recommended) == [true, false])
		#expect(q?.options.map(\.detail) == ["You create a developer app", nil])
	}
}
