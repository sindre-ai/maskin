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
}
