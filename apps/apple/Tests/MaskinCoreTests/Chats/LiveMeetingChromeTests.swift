import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("Live meeting chrome") struct LiveMeetingChromeTests {
	private var calendar: Calendar {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
		return calendar
	}

	/// Tuesday 2026-10-27 14:02 UTC.
	private let start = Date(timeIntervalSince1970: 1_793_109_720)

	private func voice(_ id: Int, session: String, at seconds: TimeInterval) -> ChatMessage {
		var m = ChatMessage.confirmed(
			serverID: id, conversationID: "c", actorID: "a", actorName: "A", author: .agent, content: "line \(id)")
		m.createdAt = start.addingTimeInterval(seconds)
		m.metadata = .object(["source": .string("voice"), "voice_session_id": .string(session)])
		return m
	}

	private func plain(_ id: Int, at seconds: TimeInterval) -> ChatMessage {
		var m = ChatMessage.confirmed(
			serverID: id, conversationID: "c", actorID: "a", actorName: "A", author: .agent, content: "text \(id)")
		m.createdAt = start.addingTimeInterval(seconds)
		return m
	}

	private func dividers(_ items: [ThreadItem]) -> [String] {
		items.map { item -> String in
			switch item {
			case .callDivider(let d): d.label
			case .message(let m, _): m.id
			default: "-"
			}
		}.filter { $0 != "-" }
	}

	@Test func theClockReadsMinutesThenHours() {
		#expect(LiveMeetingFormat.duration(4) == "0:04")
		#expect(LiveMeetingFormat.duration(59 * 60 + 59) == "59:59")
		#expect(LiveMeetingFormat.duration(3600) == "1:00:00")
		#expect(LiveMeetingFormat.duration(3604) == "1:00:04")
	}

	@Test func aCallFromAThreadSaysWhichThreadAndThatItIsLive() {
		let text = LiveMeetingChrome.subline(
			origin: .thread, threadTitle: "Developer", leadName: "Dev", startedAt: start, calendar: calendar)
		#expect(text == "Developer · live")
	}

	@Test func aCallThatMadeItsOwnThreadSaysWhoAndWhen() {
		let text = LiveMeetingChrome.subline(
			origin: .ownThread, threadTitle: "x", leadName: "Chief of Staff", startedAt: start, calendar: calendar)
		#expect(text == "Chief of Staff · Tue 14:02")
	}

	@Test func dividersReadStartedAndEndedInTwentyFourHourTime() {
		let end = start.addingTimeInterval(3600)
		#expect(LiveMeetingChrome.dividerLabel(.started, at: start, calendar: calendar) == "LIVE MEETING · STARTED 14:02")
		#expect(LiveMeetingChrome.dividerLabel(.ended, at: end, calendar: calendar) == "LIVE MEETING · ENDED 15:02")
	}

	@Test func theServersSpokenLinesGiveTheCallItsSpan() {
		let messages = [voice(1, session: "s", at: 5), voice(2, session: "s", at: 60)]
		let spans = LiveMeetingChrome.spans(messages: messages, records: [], now: start.addingTimeInterval(3600 * 3))
		#expect(spans == [LiveCallSpan(key: "s", startedAt: start.addingTimeInterval(5), endedAt: start.addingTimeInterval(60))])
	}

	@Test func aCallWithRecentLinesIsStillRunningOnAnotherDevice() {
		let messages = [voice(1, session: "s", at: 5)]
		let spans = LiveMeetingChrome.spans(messages: messages, records: [], now: start.addingTimeInterval(120))
		#expect(spans.first?.endedAt == nil)
	}

	@Test func aRecordGivesTheExactTimesAndAbsorbsItsServerLines() {
		let record = LiveCallRecord(
			id: "r", conversationID: "c", leadName: "Relay", startedAt: start, endedAt: start.addingTimeInterval(3600))
		let messages = [voice(1, session: "s", at: 5), voice(2, session: "s", at: 3000)]
		let spans = LiveMeetingChrome.spans(messages: messages, records: [record], now: start.addingTimeInterval(4000))
		#expect(spans == [LiveCallSpan(key: "r", startedAt: start, endedAt: start.addingTimeInterval(3600))])
	}

	@Test func theThreadDrawsBothDividersAroundTheCall() {
		let messages = [
			plain(1, at: -600), voice(2, session: "s", at: 10), voice(3, session: "s", at: 130), plain(4, at: 4000),
		]
		let items = ThreadLayout.items(
			for: messages, calendar: calendar, now: start.addingTimeInterval(4000))
		#expect(
			dividers(items) == [
				"m1", "LIVE MEETING · STARTED 14:02", "m2", "m3", "LIVE MEETING · ENDED 14:04", "m4",
			])
	}

	@Test func aRunningCallHasAStartDividerOnly() {
		let record = LiveCallRecord(id: "r", conversationID: "c", leadName: "Relay", startedAt: start)
		let items = ThreadLayout.items(
			for: [plain(1, at: -60)], calls: [record], calendar: calendar, now: start.addingTimeInterval(30))
		#expect(dividers(items) == ["m1", "LIVE MEETING · STARTED 14:02"])
	}

	@Test func aChatMadeForACallIsTitledLiveMeetingAndOtherChatsKeepTheirNames() {
		#expect(ThreadLayout.newChatTitle(for: ["Chief of Staff"], startsLiveCall: true) == "Live meeting")
		#expect(ThreadLayout.newChatTitle(for: ["Alex", "Relay"], startsLiveCall: false) == "Alex, Relay")
	}

	// MARK: Receipt rows, the summary and the DECIDED row among the dividers

	private func receipt(_ id: Int, _ event: String, at seconds: TimeInterval) -> ChatMessage {
		var m = ChatMessage.confirmed(
			serverID: id, conversationID: "c", actorID: "a", actorName: "A", author: .agent, content: "did \(id)",
			metadata: .object(["source": .string("voice"), "kind": .string("receipt"), "event": .string(event)]))
		m.createdAt = start.addingTimeInterval(seconds)
		return m
	}

	private func receiptSummary(_ id: Int, at seconds: TimeInterval) -> ChatMessage {
		var m = ChatMessage.confirmed(
			serverID: id, conversationID: "c", actorID: "a", actorName: "A", author: .agent, content: "Summary",
			metadata: .object(["source": .string("voice"), "kind": .string("receipt_summary")]))
		m.createdAt = start.addingTimeInterval(seconds)
		return m
	}

	private func hourCall(decisions: [LiveCallDecision] = []) -> LiveCallRecord {
		LiveCallRecord(
			id: "r", conversationID: "c", leadName: "Relay", startedAt: start, endedAt: start.addingTimeInterval(3600),
			decisions: decisions)
	}

	private func layout(_ messages: [ChatMessage], _ record: LiveCallRecord) -> [String] {
		ThreadLayout.items(
			for: messages, calls: [record], callSummaries: true, inlineTranscript: false, calendar: calendar,
			now: start.addingTimeInterval(4000)
		).compactMap { item -> String? in
			switch item {
			case .callDivider(let d): d.edge == .started ? "start" : "end"
			case .receipt(let e): e.id.hasPrefix("decided-") ? "local \(e.label)" : e.label
			case .callSummary: "summary"
			default: nil
			}
		}
	}

	@Test func aCallOfOnlyReceiptsAndASummaryIsFramedStartRowsEndSummary() {
		let messages = [
			receipt(1, "created_bet", at: 14), receipt(2, "moved_to_review", at: 31), receiptSummary(3, at: 3605),
		]
		#expect(layout(messages, hourCall()) == ["start", "CREATED BET", "MOVED TO REVIEW", "end", "summary"])
	}

	@Test func theAppsOwnSummaryComesAfterTheCallsRowsNotBeforeThem() {
		let messages = [voice(1, session: "s", at: 5), receipt(2, "created_bet", at: 14), receipt(3, "created_task", at: 19)]
		#expect(layout(messages, hourCall()) == ["start", "CREATED BET", "CREATED TASK", "end", "summary"])
	}

	@Test func aDockAnswerDrawsADecidedRowAtItsTime() {
		let answer = LiveCallDecision(at: start.addingTimeInterval(31), question: "Lift the cap", choice: "approved")
		let messages = [
			receipt(1, "created_bet", at: 14), receipt(2, "moved_to_review", at: 40), receiptSummary(3, at: 3605),
		]
		#expect(
			layout(messages, hourCall(decisions: [answer]))
				== ["start", "CREATED BET", "local DECIDED", "MOVED TO REVIEW", "end", "summary"])
	}

	@Test func aDockAnswerAfterTheLastRowStillSitsBeforeTheEndAndTheSummary() {
		let answer = LiveCallDecision(at: start.addingTimeInterval(3590), question: "Lift the cap", choice: "approved")
		let messages = [receipt(1, "created_bet", at: 14), receiptSummary(2, at: 3605)]
		#expect(
			layout(messages, hourCall(decisions: [answer])) == ["start", "CREATED BET", "local DECIDED", "end", "summary"])
	}

	@Test func theServersDecidedRowReplacesTheDockAnswerItMatches() {
		let first = LiveCallDecision(at: start.addingTimeInterval(31), question: "Lift the cap", choice: "approved")
		let second = LiveCallDecision(at: start.addingTimeInterval(200), question: "Ship it", choice: "yes")
		let messages = [receipt(1, "decided", at: 33)]
		// One server row stands in for one answer: the first goes, the second stays.
		#expect(
			layout(messages, hourCall(decisions: [first, second])) == ["start", "DECIDED", "local DECIDED", "end"])
		#expect(layout(messages, hourCall(decisions: [first])) == ["start", "DECIDED", "end"])
	}

	@Test func theDecidedRowReadsQuestionColonChoiceWithTheCallClock() {
		let answer = LiveCallDecision(at: start.addingTimeInterval(31), question: "Lift the cap", choice: "approved")
		let items = ThreadLayout.items(
			for: [], calls: [hourCall(decisions: [answer])], calendar: calendar, now: start.addingTimeInterval(4000))
		let rows = items.compactMap { if case .receipt(let e) = $0 { e } else { nil } }
		#expect(rows.map(\.text) == ["Lift the cap: approved"])
		#expect(rows.first?.timeLabel == "0:31")
	}

	@Test func aRecordKeepsItsDockAnswersAndOldRecordsHaveNone() throws {
		let answer = LiveCallDecision(id: "d", at: start, question: "Q", choice: "A")
		let kept = try JSONDecoder().decode(
			LiveCallRecord.self, from: JSONEncoder().encode(hourCall(decisions: [answer])))
		#expect(kept.decisions == [answer])
		let old = #"{"id":"r","conversationID":"c","leadName":"R","guests":[],"startedAt":0,"spoken":[]}"#
		#expect(try JSONDecoder().decode(LiveCallRecord.self, from: Data(old.utf8)).decisions.isEmpty)
	}
}
