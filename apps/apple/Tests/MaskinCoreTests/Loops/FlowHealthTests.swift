import Foundation
import Testing

@testable import MaskinCore

@Suite("Flow stuck rules, health rows and sort")
struct FlowHealthTests {
	private let now = Date(timeIntervalSince1970: 1_800_000_000)
	private let hour: TimeInterval = 3600

	private func step(_ id: String, kind: Trigger.Kind = .event) -> LoopStep {
		LoopStep(triggerID: id, name: id, triggerKind: kind)
	}

	private func event(_ id: String, _ action: String, ago: TimeInterval, session: String? = nil)
		-> LoopActivityEntry
	{
		LoopActivityEntry(
			id: id, action: action, entityType: "session", createdAt: now.addingTimeInterval(-ago),
			entityID: session)
	}

	/// Three finished runs of 10 minutes each, the newest ending `ago` seconds back.
	private func runs(endedAgo ago: TimeInterval) -> [LoopRun] {
		(0..<3).map { i in
			let end = now.addingTimeInterval(-ago - Double(i) * 7200)
			return LoopRun(
				id: "r\(i)", triggerID: "t1", status: "completed", createdAt: end.addingTimeInterval(-600),
				startedAt: end.addingTimeInterval(-600), completedAt: end)
		}
	}

	// MARK: failed step

	@Test("a failed run is matched to its step number through the run's trigger")
	func stepNumber() {
		let loop = loopRow("l")
		let problem = FlowProblems.derive(
			loop: loop, steps: [step("t0"), step("t1"), step("t2")],
			activity: [event("9", "session_failed", ago: 60, session: "s1")],
			runs: [LoopRun(id: "s1", triggerID: "t2", status: "failed")], now: now)
		#expect(problem?.kind == .stepFailed(step: 3, timedOut: false))
		#expect(problem?.headline == "Step 3 failed.")
	}

	@Test("a failure that can't be matched to a step says so without a number")
	func unknownStep() {
		let problem = FlowProblems.derive(
			loop: loopRow("l"), activity: [event("9", "session_failed", ago: 60)], now: now)
		#expect(problem?.headline == "A step failed.")
	}

	// MARK: waiting on the viewer

	@Test("a decision open for more than 48 hours is a problem, counted in whole days")
	func waitingTooLong() {
		let loop = loopRow("l", waiting: 1)
		let old = LoopPost(id: 1, actorID: "a", text: "Route?", date: now.addingTimeInterval(-60 * hour), isDecision: true)
		let problem = FlowProblems.derive(loop: loop, posts: [old], now: now)
		#expect(problem?.kind == .waitingOnYou(days: 2))
		#expect(problem?.headline == "Waiting on you for 2 days.")
	}

	@Test("a decision under 48 hours, or already answered, is not")
	func waitingFine() {
		let fresh = LoopPost(id: 1, actorID: "a", text: "Route?", date: now.addingTimeInterval(-47 * hour), isDecision: true)
		#expect(FlowProblems.derive(loop: loopRow("l", waiting: 1), posts: [fresh], now: now) == nil)
		let old = LoopPost(id: 2, actorID: "a", text: "Old", date: now.addingTimeInterval(-90 * hour), isDecision: true)
		// Nothing is waiting on the viewer, so an old decision post is history.
		#expect(FlowProblems.derive(loop: loopRow("l", waiting: 0), posts: [old], now: now) == nil)
	}

	@Test("only the newest decisions still open count, not older answered ones")
	func openDecisionsOnly() {
		let new = LoopPost(id: 2, actorID: "a", text: "New", date: now.addingTimeInterval(-3 * hour), isDecision: true)
		let answered = LoopPost(id: 1, actorID: "a", text: "Old", date: now.addingTimeInterval(-200 * hour), isDecision: true)
		#expect(FlowProblems.derive(loop: loopRow("l", waiting: 1), posts: [new, answered], now: now) == nil)
	}

	// MARK: stalled

	@Test("nothing moving for more than twice the median step time, and over 30 minutes, is stalled")
	func stalled() {
		// Median step is 10 minutes, so the floor of 30 minutes applies.
		let loop = loopRow("l", inProgress: 2)
		let problem = FlowProblems.derive(loop: loop, steps: [step("t1")], activity: [], runs: runs(endedAgo: 2 * hour), now: now)
		guard case .stalled(let idle)? = problem?.kind else {
			Issue.record("expected a stall")
			return
		}
		#expect(idle == 2 * hour)
		#expect(problem?.headline == "Nothing has moved for 2h.")
	}

	@Test("under the floor, or under twice the median, is not stalled")
	func notYetStalled() {
		let loop = loopRow("l", inProgress: 2)
		#expect(FlowProblems.derive(loop: loop, steps: [step("t1")], activity: [], runs: runs(endedAgo: 20 * 60), now: now) == nil)
		// Median 4 hours: 7 hours idle is under 2x.
		let slow = (0..<3).map { i in
			let end = now.addingTimeInterval(-7 * hour - Double(i) * 86400)
			return LoopRun(id: "s\(i)", triggerID: "t1", status: "completed", startedAt: end.addingTimeInterval(-4 * hour), completedAt: end)
		}
		#expect(FlowProblems.derive(loop: loop, steps: [step("t1")], activity: [], runs: slow, now: now) == nil)
	}

	@Test("a flow can't be called stalled with too little history, no work in flight, or a schedule still to come")
	func stalledGuards() {
		let old = runs(endedAgo: 5 * hour)
		#expect(FlowProblems.derive(loop: loopRow("l", inProgress: 2), steps: [step("t1")], activity: [], runs: Array(old.prefix(2)), now: now) == nil)
		#expect(FlowProblems.derive(loop: loopRow("l", inProgress: 0), steps: [step("t1")], activity: [], runs: old, now: now) == nil)
		let cron = LoopStep(
			triggerID: "t2", name: "t2", triggerKind: .cron, triggerConfig: .object(["expression": .string("0 9 * * *")]))
		#expect(FlowProblems.derive(loop: loopRow("l", inProgress: 2), steps: [step("t1"), cron], activity: [], runs: old, now: now) == nil)
		#expect(FlowProblems.derive(loop: loopRow("l", status: .paused, inProgress: 2), steps: [step("t1")], activity: [], runs: old, now: now) == nil)
	}

	@Test("a failure outranks a long wait, which outranks a stall")
	func priority() {
		let loop = loopRow("l", waiting: 1, inProgress: 2)
		let post = LoopPost(id: 1, actorID: "a", text: "?", date: now.addingTimeInterval(-72 * hour), isDecision: true)
		let waiting = FlowProblems.derive(loop: loop, steps: [step("t1")], activity: [], runs: runs(endedAgo: 5 * hour), posts: [post], now: now)
		#expect(waiting?.kind == .waitingOnYou(days: 3))
		let failed = FlowProblems.derive(
			loop: loop, steps: [step("t1")], activity: [event("9", "session_failed", ago: 60)], runs: [], posts: [post], now: now)
		#expect(failed?.label == "Run failed")
	}

	// MARK: health rows

	@Test("health rows read runs ok, needs you and failed over the last seven days")
	func healthRows() {
		let feed = [
			event("1", "session_created", ago: hour), event("2", "session_completed", ago: hour),
			event("3", "session_created", ago: 2 * hour), event("4", "session_failed", ago: 2 * hour),
			event("5", "session_failed", ago: 9 * 86400),
		]
		let rows = FlowHealth.rows(loop: loopRow("l", waiting: 2), activity: feed, now: now)
		#expect(rows.map(\.label) == ["Runs ok", "Needs you", "Failed"])
		#expect(rows[0].note == "1 of 2 runs finished in the last 7 days")
		#expect(rows[0].tone == .warn)
		#expect(rows[1].note == "2 decisions waiting")
		#expect(rows[2].note == "1 failed in the last 7 days")
		#expect(rows[2].tone == .bad)
	}

	@Test("a quiet flow reads as idle, not as failing")
	func healthQuiet() {
		let rows = FlowHealth.rows(loop: loopRow("l"), activity: [], now: now)
		#expect(rows[0].tone == .idle)
		#expect(rows[1].note == "Nothing")
		#expect(rows[2].note == "None in the last 7 days")
	}

	// MARK: week over week

	@Test("completed runs compare with the week before")
	func delta() {
		let feed =
			(0..<4).map { event("c\($0)", "session_completed", ago: Double($0 + 1) * 86400) }
			+ (0..<2).map { event("p\($0)", "session_completed", ago: (8 + Double($0)) * 86400) }
		let delta = FlowHealth.completedDelta(feed, now: now)
		#expect(delta == 2)
		#expect(FlowHealth.deltaText(2) == "+2 vs last week")
		#expect(FlowHealth.deltaText(-1) == "-1 vs last week")
	}

	@Test("fewer than three completed, or a full feed that can't see the earlier week, shows nothing")
	func deltaHidden() {
		let few = [event("1", "session_completed", ago: 86400), event("2", "session_completed", ago: 9 * 86400)]
		#expect(FlowHealth.completedDelta(few, now: now) == nil)
		let full = (0..<LoopRunHistory.feedLimit).map { event("e\($0)", "session_completed", ago: Double($0 + 1) * 3600) }
		#expect(FlowHealth.completedDelta(full, now: now) == nil)
	}

	// MARK: sort

	@Test("recent puts the latest touched first, name goes A to Z, ties keep the API order")
	func sorting() {
		func row(_ id: String, _ name: String, _ days: Double?) -> LoopSummary {
			LoopSummary(id: id, name: name, updatedAt: days.map { now.addingTimeInterval(-$0 * 86400) })
		}
		let loops = [row("a", "Zeta", 5), row("b", "alpha", 1), row("c", "Mid", nil), row("d", "Beta", nil)]
		#expect(LoopsSort.recent.apply(to: loops).map(\.id) == ["b", "a", "c", "d"])
		#expect(LoopsSort.name.apply(to: loops).map(\.id) == ["b", "d", "c", "a"])
	}

	@MainActor
	@Test("the store remembers the sort and applies it to the filtered list")
	func storeSort() {
		let storage = InMemoryLoopsSortStorage()
		let store = LoopsStore(api: FakeLoopsAPI([]), events: nil, sortStorage: storage)
		#expect(store.sort == .recent)
		store.sort = .name
		#expect(storage.load() == .name)
		let again = LoopsStore(api: FakeLoopsAPI([]), events: nil, sortStorage: storage)
		#expect(again.sort == .name)
	}
}
