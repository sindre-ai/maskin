import Foundation
import Testing

@testable import MaskinCore

/// A one-hour call as the server's receipt contract describes it.
private let oneHourCallJSON = """
	[
	  {"content": "Weekly brief delivered as audio", "metadata": {"source": "voice", "voice_session_id": "v1", "kind": "receipt", "event": "created_bet", "object_id": "o-bet", "text": "Weekly brief delivered as audio", "t": 14, "outcome": "ran"}},
	  {"content": "Draft customer note on webhook fix", "metadata": {"source": "voice", "voice_session_id": "v1", "kind": "receipt", "event": "created_task", "object_id": "o-task", "text": "Draft customer note on webhook fix", "t": 19, "outcome": "ran"}},
	  {"content": "Lift the PostHog event cap: approved", "metadata": {"source": "voice", "voice_session_id": "v1", "kind": "receipt", "event": "decided", "object_id": null, "text": "Lift the PostHog event cap: approved", "t": 31, "outcome": "ran"}},
	  {"content": "Webhook dedup fix in review", "metadata": {"source": "voice", "voice_session_id": "v1", "kind": "receipt", "event": "moved_to_review", "object_id": "o-task2", "text": "Webhook dedup fix in review", "t": 3604, "outcome": "ran"}},
	  {"content": "Recap by email", "metadata": {"source": "voice", "voice_session_id": "v1", "kind": "receipt", "event": "other", "text": "Send the recap by email", "t": 3000, "outcome": "not_done"}},
	  {"content": "Live meeting summary", "metadata": {"source": "voice", "voice_session_id": "v1", "kind": "receipt_summary", "duration_seconds": 3604,
	    "decided": ["Lift the PostHog event cap", "Go on the agent intro bet, Team plan only", "Keep Keychain PR 2029 ahead of the notice"],
	    "created": [{"type": "bet", "title": "Weekly brief delivered as audio", "object_id": "o-bet"}, {"type": "task", "title": "Draft customer note on webhook fix", "object_id": "o-task"}, {"type": "task", "title": "Update pricing copy, Danish"}],
	    "next": ["Recap by email to you at 15:30"], "not_done": ["Send the recap by email"]}}
	]
	"""

@MainActor
@Suite("Live receipts") struct LiveReceiptTests {
	private func messages() throws -> [ChatMessage] {
		let rows = try JSONDecoder().decode([Row].self, from: Data(oneHourCallJSON.utf8))
		return rows.enumerated().map { index, row in
			ChatMessage.confirmed(
				serverID: index + 1, conversationID: "c", actorID: "agent", actorName: "Chief of Staff",
				author: .agent, content: row.content, metadata: row.metadata)
		}
	}

	private struct Row: Decodable {
		var content: String
		var metadata: JSONValue
	}

	private func message(_ meta: [String: JSONValue], content: String = "") -> ChatMessage {
		.confirmed(
			serverID: 1, conversationID: "c", actorID: "a", actorName: "A", author: .agent, content: content,
			metadata: .object(meta))
	}

	private func event(_ meta: [String: JSONValue], content: String = "") -> LiveReceiptEvent? {
		var all = meta
		all["kind"] = .string("receipt")
		if case .event(let e) = LiveReceipt.parse(message(all, content: content)) { return e }
		return nil
	}

	@Test(arguments: [
		("created_bet", LiveReceiptKind.createdBet, "CREATED BET"),
		("created_task", .createdTask, "CREATED TASK"),
		("opened_task", .openedTask, "OPENED TASK"),
		("moved_to_review", .movedToReview, "MOVED TO REVIEW"),
		("decided", .decided, "DECIDED"),
		("other", .other, "UPDATE"),
	])
	func readsEveryEventKind(raw: String, kind: LiveReceiptKind, label: String) {
		let e = event(["event": .string(raw), "text": .string("x"), "t": .number(5)])
		#expect(e?.kind == kind)
		#expect(e?.label == label)
	}

	@Test func anUnknownEventReadsAsOther() {
		#expect(event(["event": .string("teleported"), "text": .string("x")])?.kind == .other)
	}

	@Test func missingFieldsStillGiveARowFromTheMessageContent() {
		let e = event([:], content: "Created a bet")
		#expect(e?.text == "Created a bet")
		#expect(e?.kind == .other)
		#expect(e?.objectID == nil)
		#expect(e?.seconds == nil)
		#expect(e?.timeLabel == "")
		#expect(e?.outcome == .ran)
	}

	@Test func aReceiptWithNoTextAnywhereIsNotARow() {
		#expect(event([:]) == nil)
	}

	@Test func aFailedOrUndoneChangeReadsPlainly() {
		let failed = event(["event": .string("created_task"), "text": .string("x"), "outcome": .string("failed")])
		let undone = event(["event": .string("created_task"), "text": .string("x"), "outcome": .string("not_done")])
		#expect(failed?.label == "FAILED")
		#expect(failed?.outcome.didRun == false)
		#expect(undone?.label == "NOT DONE")
		#expect(event(["text": .string("x"), "outcome": .string("???")])?.outcome == .ran)
	}

	@Test func aBlankObjectIDIsNoObject() {
		#expect(event(["text": .string("x"), "object_id": .string(" ")])?.objectID == nil)
		#expect(event(["text": .string("x"), "object_id": .null])?.objectID == nil)
	}

	@Test func formatsTimeRelativeToTheCallStart() {
		func label(_ t: Int) -> String? { event(["text": .string("x"), "t": .number(Double(t))])?.timeLabel }
		#expect(label(0) == "0:00")
		#expect(label(14) == "0:14")
		#expect(label(754) == "12:34")
		#expect(label(3604) == "1:00:04")
		#expect(label(-5) == "0:00")
	}

	@Test func otherMessagesAreNotReceipts() {
		#expect(LiveReceipt.parse(message(["kind": .string("chat")])) == nil)
		#expect(LiveReceipt.parse(message(["source": .string("voice")])) == nil)
	}

	@Test func readsTheSummary() throws {
		let all = try messages()
		guard case .summary(let s)? = LiveReceipt.parse(all[5]) else {
			Issue.record("not a summary")
			return
		}
		#expect(s.durationLabel == "1:00:04")
		#expect(s.decided.count == 3)
		#expect(s.created.map(\.type) == ["bet", "task", "task"])
		#expect(s.created[2].objectID == nil)
		#expect(s.next == ["Recap by email to you at 15:30"])
		#expect(s.notDone == ["Send the recap by email"])
		#expect(s.source == .receipt)
	}

	@Test func aSummaryWithNoFieldsIsBare() {
		guard case .summary(let s)? = LiveReceipt.parse(message(["kind": .string("receipt_summary")])) else {
			Issue.record("not a summary")
			return
		}
		#expect(s.isBare)
		#expect(s.durationLabel == "")
		#expect(s.notDone.isEmpty)
	}

	@Test func theFixtureCallFoldsIntoRowsAndOneSummary() throws {
		let t0 = Date(timeIntervalSince1970: 1_800_000_000)
		var all = try messages()
		for index in all.indices { all[index].createdAt = t0.addingTimeInterval(Double(index) * 5) }
		let record = LiveCallRecord(
			id: "call", conversationID: "c", leadName: "Chief of Staff", startedAt: t0,
			endedAt: t0.addingTimeInterval(40))
		var spoken = ChatMessage.confirmed(
			serverID: 50, conversationID: "c", actorID: "me", actorName: "Me", author: .human, content: "hello")
		spoken.createdAt = t0.addingTimeInterval(2)
		let items = ThreadLayout.items(
			for: [spoken] + all, currentActorID: "me", calls: [record], callSummaries: true)
		let rows = items.compactMap { if case .receipt(let e) = $0 { e } else { nil } }
		#expect(rows.count == 5)
		let summaries = items.compactMap { if case .callSummary(let s, let t) = $0 { (s, t?.recordID) } else { nil } }
		#expect(summaries.count == 1)
		#expect(summaries.first?.0.source == .receipt)
		#expect(summaries.first?.1 == "call")
		#expect(summaries.first?.0.title == "Live meeting with Chief of Staff")
		let card = items.compactMap { if case .liveCall(let c) = $0 { c } else { nil } }.first
		#expect(card?.messages.map(\.id) == ["m50"])
	}

	@Test func withoutAReceiptSummaryTheAppBuildsItsOwn() {
		let t0 = Date(timeIntervalSince1970: 1_800_000_000)
		var you = ChatMessage.confirmed(
			serverID: 1, conversationID: "c", actorID: "me", actorName: "Me", author: .human, content: "what is blocked")
		you.createdAt = t0.addingTimeInterval(5)
		var reply = ChatMessage.confirmed(
			serverID: 2, conversationID: "c", actorID: "relay", actorName: "Relay", author: .agent,
			content: "Three bets.")
		reply.createdAt = t0.addingTimeInterval(9)
		let record = LiveCallRecord(
			id: "call", conversationID: "c", leadName: "Relay", startedAt: t0, endedAt: t0.addingTimeInterval(421))
		let items = ThreadLayout.items(
			for: [you, reply], currentActorID: "me", calls: [record], callSummaries: true)
		guard case .callSummary(let s, let transcript)? = items.last else {
			Issue.record("no summary")
			return
		}
		#expect(s.source == .note)
		#expect(s.title == "Live meeting with Relay")
		#expect(s.durationLabel == "7:01")
		#expect(s.closing == "Three bets.")
		#expect(transcript?.recordID == "call")
		// Off by default, so layouts that never asked keep their shape.
		let plain = ThreadLayout.items(for: [you, reply], currentActorID: "me", calls: [record])
		#expect(!plain.contains { if case .callSummary = $0 { true } else { false } })
	}

	@Test func aCallStillRunningOrNeverSpokenInHasNoFallbackSummary() {
		let t0 = Date(timeIntervalSince1970: 1_800_000_000)
		let running = LiveCallRecord(id: "r", conversationID: "c", leadName: "Relay", startedAt: t0)
		#expect(LiveCallWindow.fallbackSummary(for: running, messages: [], currentActorID: "me") == nil)
		let empty = LiveCallRecord(
			id: "e", conversationID: "c", leadName: "Relay", startedAt: t0, endedAt: t0.addingTimeInterval(9))
		#expect(LiveCallWindow.fallbackSummary(for: empty, messages: [], currentActorID: "me") == nil)
	}

	@Test func aReceiptDoesNotCountAsALineOfTheCall() throws {
		let t0 = Date(timeIntervalSince1970: 1_800_000_000)
		var receipt = try messages()[0]
		receipt.createdAt = t0.addingTimeInterval(3)
		let record = LiveCallRecord(
			id: "call", conversationID: "c", leadName: "Chief of Staff", startedAt: t0,
			endedAt: t0.addingTimeInterval(40))
		#expect(!LiveCallWindow.contains(record, receipt, currentActorID: "me"))
	}
}

@MainActor
@Suite("Live transcript") struct LiveTranscriptTests {
	private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

	private func line(_ id: Int, _ who: String, _ text: String, at seconds: TimeInterval) -> ChatMessage {
		var m = ChatMessage.confirmed(
			serverID: id, conversationID: "c", actorID: who, actorName: who == "me" ? "Sebastian" : "Relay",
			author: who == "me" ? .human : .agent, content: text)
		m.createdAt = t0.addingTimeInterval(seconds)
		m.metadata = .object(["source": .string("voice")])
		return m
	}

	private func tagged(_ message: ChatMessage, _ meta: [String: JSONValue]) -> ChatMessage {
		var copy = message
		copy.metadata = .object(meta)
		return copy
	}

	private var record: LiveCallRecord {
		LiveCallRecord(
			id: "call", conversationID: "c", leadName: "Relay", startedAt: t0, endedAt: t0.addingTimeInterval(3604))
	}

	@Test func linesCarryTimeSpeakerAndTextInOrder() {
		let transcript = LiveTranscript(
			record: record,
			messages: [
				line(1, "me", "hello", at: 5), line(2, "relay", "Hi.", at: 9), line(3, "me", "wrap up", at: 3600),
			], currentActorID: "me")
		#expect(transcript.lines.map(\.timeLabel) == ["0:05", "0:09", "1:00:00"])
		#expect(transcript.lines.map(\.speaker) == ["You", "Relay", "You"])
		#expect(transcript.lines.map(\.text) == ["hello", "Hi.", "wrap up"])
		#expect(transcript.title == "Live meeting with Relay")
		#expect(transcript.subtitle == "1:00:04")
	}

	@Test func voiceLinesKeptOnTheDeviceJoinTheMessagesInTimeOrder() {
		var rec = record
		rec.lines = [LiveCallLine(isYou: true, text: "spoken", at: t0.addingTimeInterval(7))]
		let transcript = LiveTranscript(
			record: rec, messages: [line(1, "relay", "reply", at: 12), line(2, "relay", "first", at: 2)],
			currentActorID: "me")
		#expect(transcript.lines.map(\.text) == ["first", "spoken", "reply"])
		#expect(transcript.lines[1].isYou)
	}

	@Test func aLineBeforeTheStartClampsToZeroAndAnEmptyCallHasNoLines() {
		let early = LiveTranscript(record: record, messages: [line(1, "me", "x", at: -3)], currentActorID: "me")
		#expect(early.lines.first?.seconds == 0)
		#expect(LiveTranscript(record: record, messages: [], currentActorID: "me").lines.isEmpty)
	}

	@Test func theThreadHidesTheLinesButKeepsThemForTheTranscript() {
		let messages = [line(1, "me", "hello", at: 5), line(2, "relay", "Hi.", at: 9)]
		let items = ThreadLayout.items(
			for: messages, currentActorID: "me", calls: [record], callSummaries: true, inlineTranscript: false)
		#expect(!items.contains { if case .message = $0 { true } else { false } })
		#expect(!items.contains { if case .liveCall = $0 { true } else { false } })
		guard case .callSummary(_, let transcript)? = items.last else {
			Issue.record("no summary")
			return
		}
		#expect(transcript?.lines.count == 2)
	}

	@Test func aDecisionAnsweredInTheDockMakesADecidedRow() {
		let e = LiveReceiptEvent.decided(id: "d1", seconds: 31, question: "Lift the PostHog event cap", choice: "approved")
		#expect(e.kind == .decided)
		#expect(e.label == "DECIDED")
		#expect(e.timeLabel == "0:31")
		#expect(e.text == "Lift the PostHog event cap: approved")
	}

	@Test func onlyVoiceMessagesWithoutAKindAreSpokenLines() {
		let base = line(1, "relay", "x", at: 1)
		#expect(LiveSpokenLine.isSpoken(base))
		#expect(!LiveSpokenLine.isSpoken(tagged(base, ["source": .string("voice"), "kind": .string("receipt")])))
		#expect(!LiveSpokenLine.isSpoken(tagged(base, ["source": .string("voice"), "kind": .string("receipt_summary")])))
		#expect(!LiveSpokenLine.isSpoken(tagged(base, ["source": .string("voice"), "kind": .string("show")])))
		#expect(LiveSpokenLine.isSpoken(tagged(base, ["source": .string("voice"), "voice_session_id": .string("v")])))
		#expect(!LiveSpokenLine.isSpoken(tagged(base, ["source": .string("final_output")])))
		var plain = base
		plain.metadata = nil
		#expect(!LiveSpokenLine.isSpoken(plain))
	}

	@Test func shownDraftsAndTypedMessagesStayInTheThread() {
		let shown = tagged(line(2, "relay", "Here is the draft", at: 8), ["source": .string("voice"), "kind": .string("show")])
		var typed = line(3, "me", "typed", at: 9)
		typed.metadata = nil
		let items = ThreadLayout.items(
			for: [line(1, "me", "hello", at: 5), shown, typed], currentActorID: "me", calls: [record],
			callSummaries: true, inlineTranscript: false)
		let ids = items.compactMap { if case .message(let m, _) = $0 { m.id } else { nil } }
		#expect(ids == ["m2", "m3"])
		let transcripts = items.compactMap { if case .callSummary(_, let t) = $0 { t } else { nil } }
		#expect(transcripts.first?.lines.map(\.text) == ["hello"])
	}

	private func receipt(_ id: Int, at seconds: TimeInterval) -> ChatMessage {
		var m = ChatMessage.confirmed(
			serverID: id, conversationID: "c", actorID: "relay", actorName: "Relay", author: .agent, content: "Created a bet",
			metadata: .object(["source": .string("voice"), "kind": .string("receipt"), "text": .string("Created a bet")]))
		m.createdAt = t0.addingTimeInterval(seconds)
		return m
	}

	private func running() -> LiveCallRecord {
		LiveCallRecord(id: "live", conversationID: "c", leadName: "Relay", startedAt: t0)
	}

	@Test func receiptsPresentHideTheSpokenLines() {
		let messages = [line(1, "me", "hello", at: 5), receipt(2, at: 8)]
		#expect(LiveSpokenLine.hidesSpokenLines(for: running(), in: messages, currentActorID: "me"))
		let items = ThreadLayout.items(for: messages, currentActorID: "me", calls: [running()], inlineTranscript: false)
		#expect(!items.contains { if case .liveCall = $0 { true } else { false } })
	}

	@Test func theFallbackSummaryPresentHidesTheSpokenLines() {
		let messages = [line(1, "me", "hello", at: 5), line(2, "relay", "Hi.", at: 9)]
		#expect(LiveSpokenLine.hidesSpokenLines(for: record, in: messages, currentActorID: "me"))
	}

	@Test func withNeitherTheCallKeepsItsFoldedCard() {
		let messages = [line(1, "me", "hello", at: 5), line(2, "relay", "Hi.", at: 9)]
		// Still running and no receipt yet: nothing has replaced the lines.
		#expect(!LiveSpokenLine.hidesSpokenLines(for: running(), in: messages, currentActorID: "me"))
		let items = ThreadLayout.items(
			for: messages, currentActorID: "me", calls: [running()], callSummaries: true, inlineTranscript: false)
		#expect(items.contains { if case .liveCall = $0 { true } else { false } })
		// A call that ended with nothing said has no fallback summary either.
		#expect(!LiveSpokenLine.hidesSpokenLines(for: record, in: [], currentActorID: "me"))
	}

	@Test func twoCallsInOneThreadAreDecidedIndependently() {
		let first = LiveCallRecord(
			id: "one", conversationID: "c", leadName: "Relay", startedAt: t0, endedAt: t0.addingTimeInterval(60))
		let second = LiveCallRecord(
			id: "two", conversationID: "c", leadName: "Relay", startedAt: t0.addingTimeInterval(1000))
		let messages = [
			line(1, "me", "first call", at: 5), line(2, "relay", "ok", at: 9),
			line(3, "me", "second call", at: 1005), line(4, "relay", "sure", at: 1009),
		]
		let items = ThreadLayout.items(
			for: messages, currentActorID: "me", calls: [first, second], callSummaries: true, inlineTranscript: false)
		let cards = items.compactMap { if case .liveCall(let c) = $0 { c } else { nil } }
		#expect(cards.map(\.record.id) == ["two"])
		let summaries = items.compactMap { if case .callSummary(_, let t) = $0 { t?.recordID } else { nil } }
		#expect(summaries == ["one"])
	}
}
