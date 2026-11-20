import Foundation
import Testing

@testable import MaskinCore

private func session(
	_ id: String = "s1", status: String = "running", prompt: String = "Draft the note", actor: String = "relay",
	name: String = "Relay", dependsOn: [String] = []
) -> SpawnedSession {
	SpawnedSession(
		id: id, status: status, actorID: actor, actorName: name, actionPrompt: prompt, dependsOn: dependsOn)
}

@Suite("SpawnedSession")
struct SpawnedSessionTests {
	@Test("statuses map to the web strip's pills, and the rest are left out", arguments: [
		("pending", HandoffPill.queued), ("starting", .queued), ("running", .working),
		("completed", .done), ("failed", .failed), ("timeout", .failed),
	])
	func pills(raw: String, pill: HandoffPill) {
		#expect(session(status: raw).pill == pill)
	}

	@Test("paused and unknown statuses have no pill")
	func unmapped() {
		#expect(session(status: "paused").pill == nil)
		#expect(session(status: "snapshotting").pill == nil)
	}

	@Test("only queued and working sessions are live")
	func live() {
		#expect(session(status: "pending").isLive)
		#expect(session(status: "running").isLive)
		#expect(!session(status: "completed").isLive)
		#expect(!session(status: "failed").isLive)
	}

	@Test("the title is the first non-empty line without heading marks, capped")
	func title() {
		#expect(session(prompt: "\n  ## Draft the note \nMore detail").title == "Draft the note")
		#expect(session(prompt: String(repeating: "x", count: 500)).title.count == SpawnedSession.maxTitleLength)
		#expect(session(prompt: "  ").title == "")
	}

	@Test("elapsed counts up while working and shows the total when done")
	func elapsed() {
		let start = Date(timeIntervalSince1970: 1_700_000_000)
		var s = session()
		s.startedAt = start
		#expect(s.elapsedLabel(now: start.addingTimeInterval(42)) == "42s")
		#expect(s.elapsedLabel(now: start.addingTimeInterval(185)) == "3m")
		s.status = "completed"
		s.durationMs = 3_900_000
		#expect(s.elapsedLabel(now: start) == "1h 5m")
		s.status = "failed"
		#expect(s.elapsedLabel(now: start) == nil)
	}

	@Test("the activity line only shows while working")
	func activity() {
		var s = session()
		s.currentActivity = "  Reading the brief "
		#expect(s.liveActivity == "Reading the brief")
		s.status = "completed"
		#expect(s.liveActivity == nil)
		s.status = "running"
		s.currentActivity = "  "
		#expect(s.liveActivity == nil)
	}

	@Test("a failure reads the result like the web: failure_reason, error, message, else generic")
	func failure() {
		func outcome(_ result: JSONValue?) -> String? { SpawnedSession.outcome(from: result, pill: .failed) }
		#expect(outcome(.object(["failure_reason": .string("quota_exhausted_5h")])) == "quota_exhausted_5h")
		#expect(outcome(.object(["error": .string("boom")])) == "boom")
		#expect(outcome(.object(["failure_reason": .object(["message": .string("No credits")])])) == "No credits")
		#expect(outcome(.object(["exit_code": .number(1)])) == SpawnedSession.genericFailure)
		#expect(outcome(nil) == SpawnedSession.genericFailure)
		#expect(outcome(.string("plain")) == "plain")
	}

	@Test("a finished session shows its summary and nothing invented")
	func summary() {
		#expect(SpawnedSession.outcome(from: .object(["summary": .string("All done")]), pill: .done) == "All done")
		#expect(SpawnedSession.outcome(from: .object(["exit_code": .number(0)]), pill: .done) == nil)
		#expect(SpawnedSession.outcome(from: .object(["summary": .string("x")]), pill: .working) == nil)
	}
}

@Suite("ThreadLayout handoffs")
struct ThreadLayoutHandoffTests {
	private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

	private func message(_ id: Int, _ actor: String, at offset: TimeInterval, spawned: [SpawnedSession] = []) -> ChatMessage {
		.confirmed(
			serverID: id, conversationID: "c", actorID: actor, actorName: actor, author: .agent, content: "hi",
			createdAt: t0.addingTimeInterval(offset), spawnedSessions: spawned)
	}

	@Test("a message's spawned sessions follow it as one card, with dependency names resolved within the message")
	func followsTheMessage() {
		let a = session("a", name: "Sentinel")
		let b = session("b", status: "pending", name: "Forge", dependsOn: ["a", "elsewhere"])
		let items = ThreadLayout.items(for: [message(1, "x", at: 0, spawned: [a, b]), message(2, "y", at: 10)])
		let cards = items.filter { if case .handoff = $0 { true } else { false } }
		#expect(cards == [.handoff([HandoffEntry(a), HandoffEntry(b, behind: ["Sentinel"])])])
		let kinds = items.compactMap { item -> String? in
			switch item {
			case .message(let m, _): m.id
			case .handoff(let entries): "handoff-\(entries[0].session.id)"
			default: nil
			}
		}
		#expect(kinds == ["m1", "handoff-a", "m2"])
	}

	@Test("sessions without a pill are left out")
	func skipsUnmapped() {
		let items = ThreadLayout.items(for: [message(1, "x", at: 0, spawned: [session(status: "paused")])])
		#expect(!items.contains { if case .handoff = $0 { true } else { false } })
	}

	@Test("a handoff card breaks the author's run")
	func breaksTheRun() {
		let items = ThreadLayout.items(for: [
			message(1, "x", at: 0, spawned: [session()]), message(2, "x", at: 30),
		])
		let runs = ThreadLayout.runs(in: items)
		#expect(runs["m1"]?.endsRun == true)
		#expect(runs["m2"]?.previousID == nil)
		guard case .message(_, let showsAuthor) = items.last else {
			Issue.record("no message last")
			return
		}
		#expect(showsAuthor)
	}

	@Test("handoff ids are unique and stable")
	func ids() {
		let items = ThreadLayout.items(for: [message(1, "x", at: 0, spawned: [session("a"), session("b")])])
		let ids = items.map(\.id)
		#expect(Set(ids).count == ids.count)
		#expect(ids.contains("handoff-a"))
	}
}

@Suite("QuestionTextSplit")
struct QuestionTextSplitTests {
	private let draft = "Subject: Luma event\n\nHi Maya, thanks for hosting us next week. We would love to bring two people."

	@Test("a question followed by a long text splits at the question mark")
	func splitsAtTheQuestion() {
		let split = QuestionTextSplit("Send this to Maya? \(draft)")
		#expect(split.lead == "Send this to Maya?")
		#expect(split.detail == draft)
	}

	@Test("a short text after the question mark stays whole")
	func shortRestStaysWhole() {
		let split = QuestionTextSplit("Ship it now? Yes or no.")
		#expect(split.lead == "Ship it now? Yes or no.")
		#expect(split.detail == nil)
	}

	@Test("a question mark inside a link is not a question")
	func linkQuestionMark() {
		let text = "See https://maskin.io/x?tab=1 for the page and tell me what you think about the wording there"
		#expect(QuestionTextSplit(text).detail == nil)
	}

	@Test("a long text with no question splits after the first sentence")
	func longTextFirstSentence() {
		let rest = String(repeating: "More detail follows here. ", count: 6)
		let split = QuestionTextSplit("Pick the launch date. \(rest)")
		#expect(split.lead == "Pick the launch date.")
		#expect(split.detail == rest.trimmingCharacters(in: .whitespaces))
	}

	@Test("a short text with no question is the lead")
	func shortText() {
		let split = QuestionTextSplit("Which one?")
		#expect(split.lead == "Which one?")
		#expect(split.detail == nil)
	}

	@Test("line breaks in the detail are kept")
	func keepsLineBreaks() {
		#expect(QuestionTextSplit("Is this right? \(draft)").detail?.contains("\n\n") == true)
	}
}
