import Foundation
import Testing

@testable import MaskinCore

@Suite("CommentBlocks")
struct CommentBlocksTests {
	private func decode(_ json: String) -> JSONValue {
		try! JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
	}

	@Test func parsesADecisionWithItsOptions() {
		let value = decode(#"{"title":"Which plan?","summary":"Pick one.","options":[{"label":"Middle plan","recommended":true},{"label":"Keep all three"}]}"#)
		let decision = CommentDecision.parse(value)
		#expect(decision?.title == "Which plan?")
		#expect(decision?.options.map(\.label) == ["Middle plan", "Keep all three"])
		#expect(decision?.options.first?.recommended == true)
	}

	@Test func aDecisionNeedsTwoOptions() {
		#expect(CommentDecision.parse(decode(#"{"title":"x","options":[{"label":"Only"}]}"#)) == nil)
		#expect(CommentDecision.parse(nil) == nil)
	}

	@Test func aReplyMatchingALabelAnswersIt() {
		let decision = CommentDecision.parse(decode(#"{"title":"x","options":[{"label":"Yes"},{"label":"No"}]}"#))
		#expect(decision?.answer(in: ["thanks", " yes "]) == "Yes")
		#expect(decision?.answer(in: ["maybe"]) == nil)
	}

	@Test func taskIdsKeepOnlyUniqueUUIDs() {
		let id = UUID().uuidString
		let value = decode(#"{"metadata":{"tasks":["\#(id)","\#(id)","not-an-id"]}}"#)
		#expect(CommentTasks.ids(in: value) == [id])
	}
}
