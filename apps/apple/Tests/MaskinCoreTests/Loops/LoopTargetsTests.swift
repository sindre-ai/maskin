import Foundation
import Testing

@testable import MaskinCore

@Suite("Loop targets")
struct LoopTargetsTests {
	private func target(_ actual: Double, of goal: Double, strict: Bool = false) -> LoopTarget {
		LoopTarget(label: "Customers", actual: actual, target: goal, isStrict: strict)
	}

	private func loop(
		_ id: String, targets: [LoopTarget]?, status: LoopPill = .learning, waiting: Int = 0
	) -> LoopSummary {
		LoopSummary(
			id: id, name: "Loop \(id)", status: status,
			pill: (status.isLive && waiting > 0) ? .waitingOnYou : status, waitingCount: waiting,
			targets: targets)
	}

	@Test("status follows actual against target like the web's pace verdict")
	func thresholds() {
		#expect(LoopOutcomes.status(of: target(0, of: 10)) == .atRisk)  // missed
		#expect(LoopOutcomes.status(of: target(3, of: 10)) == .atRisk)  // behind, under half
		#expect(LoopOutcomes.status(of: target(5, of: 10)) == .watch)  // behind, half or more
		#expect(LoopOutcomes.status(of: target(8.9, of: 10)) == .watch)
		#expect(LoopOutcomes.status(of: target(9, of: 10)) == .onTrack)  // window: 90% is on target
		#expect(LoopOutcomes.status(of: target(12, of: 10)) == .onTrack)  // above
	}

	@Test("strict pacing needs the full goal")
	func strict() {
		#expect(LoopOutcomes.status(of: target(9, of: 10, strict: true)) == .watch)
		#expect(LoopOutcomes.status(of: target(10, of: 10, strict: true)) == .onTrack)
	}

	@Test("a zero goal is on track once anything happened, otherwise behind")
	func zeroGoal() {
		#expect(LoopOutcomes.status(of: target(0, of: 0)) == .atRisk)
		#expect(LoopOutcomes.status(of: target(2, of: 0)) == .onTrack)
	}

	@Test("a loop waiting on the viewer reads Needs you")
	func needsYou() {
		#expect(LoopOutcomes.status(of: target(9, of: 10), waitingOnYou: true) == .needsYou)
		let cards = LoopOutcomes.cards(for: loop("a", targets: [target(9, of: 10)], waiting: 2))
		#expect(cards.map(\.status) == [.needsYou])
	}

	@Test("the bar fraction is clamped to 0...1")
	func fraction() {
		#expect(target(5, of: 10).fraction == 0.5)
		#expect(target(20, of: 10).fraction == 1)
		#expect(target(-1, of: 10).fraction == 0)
		#expect(target(3, of: 0).fraction == 1)
	}

	@Test("no targets means no cards")
	func hiddenWhenEmpty() {
		#expect(LoopOutcomes.cards(for: loop("a", targets: nil)).isEmpty)
		#expect(LoopOutcomes.cards(for: loop("a", targets: [])).isEmpty)
		#expect(LoopOutcomes.cards(for: [loop("a", targets: nil), loop("b", targets: [])]).isEmpty)
	}

	@Test("score cards flatten every loop, most urgent first, list order within a status")
	func ordering() {
		let loops = [
			loop("a", targets: [target(10, of: 10)]),
			loop("b", targets: [target(1, of: 10), target(6, of: 10)]),
			loop("c", targets: [target(0, of: 5)]),
		]
		let cards = LoopOutcomes.cards(for: loops)
		#expect(cards.map(\.loopID) == ["b", "c", "b", "a"])
		#expect(cards.map(\.status) == [.atRisk, .atRisk, .watch, .onTrack])
	}

	@Test("a snapshot cached before targets existed still decodes")
	func oldSnapshot() throws {
		let data = try JSONEncoder().encode(loop("a", targets: nil))
		var object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
		object["targets"] = nil
		let old = try JSONSerialization.data(withJSONObject: object)
		#expect(try JSONDecoder().decode(LoopSummary.self, from: old).targets == nil)
	}

	@Test("quality stats are the loop's real counts, with dashes for what is missing")
	func quality() {
		var row = loop("a", targets: nil)
		row.inProgressCount = 3
		row.closedCount = 12
		row.waitingCount = 2
		row.medianTimeToClose = 3600
		let stats = LoopQuality.stats(
			for: row, nextRun: nil, duration: { "\(Int($0 / 60))m" }, date: { _ in "soon" })
		#expect(stats.map(\.label) == ["In progress", "Closed", "Median time", "Needs you", "Next run"])
		#expect(stats.map(\.value) == ["3", "12", "60m", "2", "—"])
		row.medianTimeToClose = nil
		let later = LoopQuality.stats(
			for: row, nextRun: Date(), duration: { _ in "" }, date: { _ in "soon" })
		#expect(later.map(\.value) == ["3", "12", "—", "2", "soon"])
	}

	@Test("next run is the earliest scheduled step, none when paused or event-only")
	func nextRun() {
		let now = Date(timeIntervalSince1970: 1_800_000_000)
		let at = now.addingTimeInterval(7200)
		let iso = Date.ISO8601FormatStyle().format(at)
		let reminder = LoopStep(
			triggerID: "t1", name: "Remind", triggerKind: .reminder,
			triggerConfig: .object(["scheduled_at": .string(iso)]))
		let event = LoopStep(triggerID: "t2", name: "On change", triggerKind: .event)
		#expect(
			LoopQuality.nextRun(steps: [event, reminder], now: now, paused: false)?
				.timeIntervalSince1970 == at.timeIntervalSince1970.rounded())
		#expect(LoopQuality.nextRun(steps: [event, reminder], now: now, paused: true) == nil)
		#expect(LoopQuality.nextRun(steps: [event], now: now, paused: false) == nil)
	}
}
