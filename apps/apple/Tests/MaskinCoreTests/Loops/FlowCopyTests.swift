import Foundation
import Testing

@testable import MaskinCore

@Suite("Flows list copy and derived signals")
struct FlowCopyTests {
	// MARK: subtitle

	@Test("the subtitle spells counts out and agrees in number")
	func subtitle() {
		#expect(FlowsSummary.line(running: 3, needYou: 2) == "Three outcomes in motion. Two need you.")
		#expect(FlowsSummary.line(running: 1, needYou: 1) == "One outcome in motion. One needs you.")
		#expect(FlowsSummary.line(running: 4, needYou: 0) == "Four outcomes in motion.")
		#expect(FlowsSummary.line(running: 14, needYou: 1) == "14 outcomes in motion. One needs you.")
	}

	@Test("the subtitle is absent when nothing runs and never counts more needing you than running")
	func subtitleBounds() {
		#expect(FlowsSummary.line(running: 0, needYou: 0) == nil)
		#expect(FlowsSummary.line(running: 2, needYou: 5) == "Two outcomes in motion. Two need you.")
	}

	// MARK: latest update sentence

	@Test("a short post is kept whole, with its markdown flattened")
	func shortPost() {
		let text = LoopLatestUpdate.sentence(from: "**Scored** 12 leads.\n\n- [Acme](https://x.test) is hot")
		#expect(text == "Scored 12 leads. Acme is hot")
	}

	@Test("a long post is cut at the last whole sentence that fits")
	func longPostCutsAtSentence() {
		let first = "Scored twelve leads and routed the three hottest to Alex before lunch."
		let second = "The webinar list is our best source this quarter."
		let third = "Next I will draft the follow-up sequence and ask you which tone to use for each segment."
		let text = LoopLatestUpdate.sentence(from: [first, second, third].joined(separator: " "))
		#expect(text == first + " " + second)
		#expect(text.count <= LoopLatestUpdate.limit)
	}

	@Test("a first sentence that is too long is cut at a word with an ellipsis")
	func longSingleSentence() {
		let words = Array(repeating: "reconciliation", count: 20).joined(separator: " ")
		let text = LoopLatestUpdate.sentence(from: words)
		#expect(text.hasSuffix("…"))
		#expect(text.count <= LoopLatestUpdate.limit + 1)
		#expect(!text.dropLast().hasSuffix(" "))
	}

	@Test("a post with no text yields no line")
	func emptyPost() {
		let post = LoopPost(id: 1, actorID: "a", text: "   ")
		#expect(LoopLatestUpdate.line(post: post, author: "Relay") == nil)
		let real = LoopPost(id: 2, actorID: "a", text: "Done.")
		#expect(LoopLatestUpdate.line(post: real, author: "Relay") == .init(author: "Relay", text: "Done."))
	}

	// MARK: problem banner

	private let now = Date(timeIntervalSince1970: 1_800_000_000)

	private func entry(_ id: String, _ action: String, ago: TimeInterval, note: String? = nil)
		-> LoopActivityEntry
	{
		LoopActivityEntry(
			id: id, action: action, entityType: "session", actorID: "agent-1", description: note,
			createdAt: now.addingTimeInterval(-ago))
	}

	@Test("a failed run with nothing after it is a problem")
	func failedRun() {
		let loop = loopRow("l")
		let feed = [entry("2", "session_failed", ago: 600, note: "Scout hit a rate limit"), entry("1", "session_completed", ago: 7200)]
		let problem = FlowProblems.derive(loop: loop, activity: feed, now: now)
		#expect(problem?.kind == .stepFailed(step: nil, timedOut: false))
		#expect(problem?.detail == "Scout hit a rate limit")
		#expect(problem?.label == "Run failed")
	}

	@Test("a timeout reads as timed out")
	func timedOut() {
		let problem = FlowProblems.derive(
			loop: loopRow("l"), activity: [entry("1", "session_timeout", ago: 60)], now: now)
		#expect(problem?.kind == .stepFailed(step: nil, timedOut: true))
	}

	@Test("a run that started or finished after the failure clears the problem, whatever order the feed is in")
	func recovered() {
		let loop = loopRow("l")
		let retry = [entry("1", "session_failed", ago: 3600), entry("2", "session_running", ago: 60)]
		#expect(FlowProblems.derive(loop: loop, activity: retry, now: now) == nil)
		#expect(FlowProblems.derive(loop: loop, activity: retry.reversed(), now: now) == nil)
		let done = [entry("1", "session_failed", ago: 3600), entry("2", "session_completed", ago: 60)]
		#expect(FlowProblems.derive(loop: loop, activity: done, now: now) == nil)
	}

	@Test("a paused or draft flow is stopped, not stuck")
	func stoppedFlows() {
		let feed = [entry("1", "session_failed", ago: 60)]
		#expect(FlowProblems.derive(loop: loopRow("l", status: .paused), activity: feed, now: now) == nil)
		#expect(FlowProblems.derive(loop: loopRow("l", status: .draft), activity: feed, now: now) == nil)
	}

	@Test("an old failure is history")
	func oldFailure() {
		let feed = [entry("1", "session_failed", ago: FlowProblems.window + 60)]
		#expect(FlowProblems.derive(loop: loopRow("l"), activity: feed, now: now) == nil)
	}

	@Test("trigger firings and other events neither raise nor clear a problem")
	func otherEvents() {
		let feed = [
			LoopActivityEntry(id: "9", action: "trigger_fired", entityType: "trigger", createdAt: now),
			entry("1", "session_failed", ago: 600),
		]
		#expect(FlowProblems.derive(loop: loopRow("l"), activity: feed, now: now)?.kind == .stepFailed(step: nil, timedOut: false))
	}

	// MARK: last seven days

	private var calendar: Calendar {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = TimeZone(identifier: "UTC")!
		return calendar
	}

	private var noon: Date { calendar.date(from: DateComponents(year: 2026, month: 10, day: 7, hour: 12))! }

	private func at(daysAgo: Int, hour: Int = 9, _ action: String) -> LoopActivityEntry {
		let day = calendar.date(byAdding: .day, value: -daysAgo, to: calendar.startOfDay(for: noon))!
		let date = calendar.date(byAdding: .hour, value: hour, to: day)!
		return LoopActivityEntry(id: "\(daysAgo)-\(hour)-\(action)", action: action, entityType: "session", createdAt: date)
	}

	@Test("seven days end today, oldest first")
	func sevenDays() {
		let days = LoopRunHistory.days(from: [], now: noon, calendar: calendar)
		#expect(days.count == 7)
		#expect(days.last?.isToday == true)
		#expect(days.first?.day == calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: noon)))
		#expect(days.allSatisfy { $0.runs == 0 })
	}

	@Test("runs count sessions started that day and failures count the ones that did not finish")
	func buckets() {
		let feed = [
			at(daysAgo: 0, hour: 8, "session_created"), at(daysAgo: 0, hour: 9, "session_completed"),
			at(daysAgo: 0, hour: 10, "session_created"), at(daysAgo: 0, hour: 11, "session_failed"),
			at(daysAgo: 2, "session_created"), at(daysAgo: 2, "session_timeout"),
			at(daysAgo: 9, "session_created"),
		]
		let days = LoopRunHistory.days(from: feed, now: noon, calendar: calendar)
		#expect(days[6].runs == 2)
		#expect(days[6].failures == 1)
		#expect(days[4].runs == 1)
		#expect(days[4].failures == 1)
		#expect(days.reduce(0) { $0 + $1.runs } == 3)
	}

	@Test("a day where only the finish is in the feed still counts the run")
	func finishOnly() {
		let days = LoopRunHistory.days(
			from: [at(daysAgo: 1, "session_completed")], now: noon, calendar: calendar)
		#expect(days[5].runs == 1)
	}

	@Test("the summary reads in plain words")
	func summary() {
		let days = LoopRunHistory.days(
			from: [at(daysAgo: 0, "session_created"), at(daysAgo: 0, "session_failed")], now: noon,
			calendar: calendar)
		#expect(LoopRunHistory.summary(days) == "1 run, 1 failed")
		#expect(LoopRunHistory.summary(LoopRunHistory.days(from: [], now: noon, calendar: calendar)) == "No runs")
	}

	@Test("a full feed that does not reach back seven days may be truncated")
	func truncation() {
		let full = (0..<LoopRunHistory.feedLimit).map { at(daysAgo: 1, hour: $0 % 20, "session_created") }
		#expect(LoopRunHistory.mayBeTruncated(full, now: noon, calendar: calendar))
		let reaching = full + [at(daysAgo: 8, "session_created")]
		#expect(!LoopRunHistory.mayBeTruncated(reaching, now: noon, calendar: calendar))
		#expect(!LoopRunHistory.mayBeTruncated(Array(full.prefix(5)), now: noon, calendar: calendar))
	}

	// MARK: quality cards

	@Test("quality shows three tiles: cycles done, decisions needed and failed steps")
	func qualityCards() {
		let loop = loopRow("l", waiting: 3, closed: 12)
		let cards = LoopQuality.cardStats(for: loop, failedSteps: 2)
		#expect(cards.map(\.label) == ["Cycles done", "Decisions needed", "Failed steps"])
		#expect(cards.map(\.value) == ["12", "3", "2"])
	}

	// MARK: one-line card update

	@Test("the card's update is cut shorter than the page's")
	func cardLine() {
		let words = Array(repeating: "reconciliation", count: 20).joined(separator: " ")
		let post = LoopPost(id: 1, actorID: "a", text: words)
		let card = LoopLatestUpdate.line(post: post, author: "Relay", limit: LoopLatestUpdate.cardLimit)
		#expect((card?.text.count ?? 0) <= LoopLatestUpdate.cardLimit + 1)
		#expect(card?.text.hasSuffix("…") == true)
	}
}
