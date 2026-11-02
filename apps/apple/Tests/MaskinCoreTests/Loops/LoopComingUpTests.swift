import Foundation
import Testing

@testable import MaskinCore

@Suite("LoopComingUp")
struct LoopComingUpTests {
	private func cron(_ id: String, _ expression: String) -> LoopStep {
		LoopStep(
			triggerID: id, name: id, triggerKind: .cron,
			triggerConfig: .object(["expression": .string(expression)]))
	}

	private func event(_ id: String) -> LoopStep {
		LoopStep(triggerID: id, name: id, triggerKind: .event)
	}

	/// 2026-10-06 12:00 UTC.
	private let now = Date(timeIntervalSince1970: 1_791_288_000)

	@Test("scheduled steps come first, soonest first, then the event-driven ones in order")
	func ordering() {
		let items = LoopComingUp.items(
			steps: [event("e1"), cron("later", "0 18 * * *"), cron("sooner", "30 13 * * *"), event("e2")],
			now: now)
		#expect(items.map(\.step.triggerID) == ["sooner", "later", "e1", "e2"])
		#expect(items[0].next == CronSchedule(expression: "30 13 * * *")?.nextFire(after: now))
		#expect(items[2].next == nil)
	}

	@Test("a cron the app does not model has no time but is still listed")
	func unmodelledCron() {
		let items = LoopComingUp.items(steps: [cron("odd", "*/5 * * * *")], now: now)
		#expect(items.count == 1)
		#expect(items[0].next == nil)
	}

	@Test("a reminder shows its date while ahead and none once it has passed")
	func reminders() {
		func reminder(_ at: String) -> LoopStep {
			LoopStep(
				triggerID: at, name: at, triggerKind: .reminder,
				triggerConfig: .object(["scheduled_at": .string(at)]))
		}
		let items = LoopComingUp.items(
			steps: [reminder("2026-10-05T09:00:00Z"), reminder("2026-10-07T09:00:00Z")], now: now)
		#expect(items.map(\.step.triggerID) == ["2026-10-07T09:00:00Z", "2026-10-05T09:00:00Z"])
		#expect(items[1].next == nil)
	}

	@Test("a paused loop lists its steps with no times")
	func paused() {
		let items = LoopComingUp.items(steps: [cron("a", "0 9 * * *")], now: now, paused: true)
		#expect(items.map(\.next) == [nil])
	}
}
