import Foundation

/// What a loop will do next, from its steps' triggers: scheduled steps in the order they fire
/// (with the time), then the steps that only wake on an event.
public enum LoopComingUp {
	public struct Item: Identifiable, Equatable, Sendable {
		public var step: LoopStep
		/// When the step next runs on its own; nil for event-driven steps and for a paused loop.
		public var next: Date?
		public var id: String { step.id }
	}

	/// Cron steps fire at their next UTC schedule time, reminders at their date while it is ahead.
	/// A paused loop has nothing coming, so every step is listed without a time.
	public static func items(steps: [LoopStep], now: Date, paused: Bool = false) -> [Item] {
		let items = steps.map { Item(step: $0, next: paused ? nil : nextRun(of: $0, after: now)) }
		let scheduled = items.filter { $0.next != nil }.sorted { $0.next! < $1.next! }
		return scheduled + items.filter { $0.next == nil }
	}

	static func nextRun(of step: LoopStep, after now: Date) -> Date? {
		switch step.triggerKind {
		case .cron:
			guard let expression = step.triggerConfig["expression"]?.stringValue else { return nil }
			return CronSchedule(expression: expression)?.nextFire(after: now)
		case .reminder:
			guard let at = AutomationDates.parse(step.triggerConfig["scheduled_at"]?.stringValue), at > now
			else { return nil }
			return at
		case .event, .other:
			return nil
		}
	}
}
