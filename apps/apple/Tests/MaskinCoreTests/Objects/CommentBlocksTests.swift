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

	@Test func aDefaultOnSilenceShowsItsLine() {
		let value = decode(#"{"title":"x","expires_at":"2026-11-20T14:00:00Z","options":[{"label":"Hold","default_on_silence":true},{"label":"Go"}]}"#)
		let decision = CommentDecision.parse(value)
		#expect(decision?.options.first?.defaultOnSilence == true)
		#expect(decision?.silenceLine?.hasPrefix("If nobody answers by ") == true)
		#expect(decision?.silenceLine?.hasSuffix(#"the default is "Hold"."#) == true)
	}

	@Test func noLineWithoutADefaultOrADeadline() {
		let noDefault = decode(#"{"title":"x","expires_at":"2026-11-20T14:00:00Z","options":[{"label":"Hold"},{"label":"Go"}]}"#)
		let noDeadline = decode(#"{"title":"x","options":[{"label":"Hold","default_on_silence":true},{"label":"Go"}]}"#)
		#expect(CommentDecision.parse(noDefault)?.silenceLine == nil)
		#expect(CommentDecision.parse(noDeadline)?.silenceLine == nil)
	}

	@Test func taskIdsKeepOnlyUniqueUUIDs() {
		let id = UUID().uuidString
		let value = decode(#"{"metadata":{"tasks":["\#(id)","\#(id)","not-an-id"]}}"#)
		#expect(CommentTasks.ids(in: value) == [id])
	}
}
