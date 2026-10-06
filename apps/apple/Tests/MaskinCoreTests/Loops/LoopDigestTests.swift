import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("LoopDigest")
struct LoopDigestTests {
	@Test("first sentence stops at the sentence end and drops markdown")
	func firstSentence() {
		let text = "**Cycle 14** structuring done. 14 insights extracted.\nCluster built."
		#expect(LoopDigest.firstSentence(of: text) == "Cycle 14 structuring done.")
	}

	@Test("a sentence without punctuation is kept whole; a dotted number does not end it")
	func noTerminator() {
		#expect(LoopDigest.firstSentence(of: "Waiting on 3.5 signals before we ship") == "Waiting on 3.5 signals before we ship")
	}

	@Test("a long sentence is cut at a word near 130 characters with an ellipsis")
	func longSentence() {
		let long = Array(repeating: "word", count: 60).joined(separator: " ")
		let result = LoopDigest.firstSentence(of: long)
		#expect(result.count <= LoopDigest.maxSentenceLength + 1)
		#expect(result.hasSuffix("…"))
		#expect(!result.contains("wor…"))
	}

	@Test("digest takes the newest post, its author, the decision flag and the open stage")
	func build() {
		let overview = LoopOverview(
			members: [
				LoopMember(id: "1", type: "task", title: "A", status: "todo"),
				LoopMember(id: "2", type: "task", title: "B", status: "in_progress"),
				LoopMember(id: "3", type: "task", title: "C", status: "done"),
			],
			posts: [
				LoopPost(id: 2, actorID: "agent-1", text: "Drafted the brief. Needs a look.", isDecision: true),
				LoopPost(id: 1, actorID: "agent-2", text: "Older."),
			],
			outputs: [], statusOrder: ["backlog", "todo", "in_progress", "done"])
		let digest = LoopDigest.build(from: overview)
		#expect(digest.stage == "in_progress")
		#expect(digest.latestAuthorID == "agent-1")
		#expect(digest.latestSentence == "Drafted the brief.")
		#expect(digest.hasDecision)
	}

	@Test("progress and cycle come from the closed and in-progress counts")
	func progress() {
		let loop = loopRow("a", inProgress: 3, closed: 1)
		#expect(loop.progress == 0.25)
		#expect(loop.cycleLabel == "Cycle 2")
		#expect(loopRow("b", inProgress: 0, closed: 0).progress == 0)
	}

	@Test("a decision post makes a loop need you, in the section, the count and the subtitle")
	func needsRule() async {
		let api = FakeLoopsAPI([
			loopRow("a", status: .learning), loopRow("b", status: .supervised, waiting: 1),
			loopRow("c", status: .paused),
		])
		await api.setOverview(
			LoopOverview(
				members: [], posts: [LoopPost(id: 1, actorID: nil, text: "Pick one.", isDecision: true)],
				outputs: [], statusOrder: []))
		let store = LoopsStore(api: api, events: nil)
		await store.start()
		#expect(store.summaryLine == "2 outcomes in motion. 1 needs you.")
		await store.loadDigests()
		// The fake returns the same decision for every loop; the paused one is not in motion.
		#expect(store.needYouCount == 2)
		#expect(store.summaryLine == "2 outcomes in motion. 2 need you.")
		#expect(store.sections().first?.label == "Waiting on you")
	}
}
