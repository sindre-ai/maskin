import Foundation

/// One row of the activity page: a day heading, a comment, or a run of system events folded
/// into a single line.
public enum TimelineRowModel: Identifiable, Equatable, Sendable {
	case day(id: String, label: String)
	case item(TimelineItem)
	/// Consecutive system events, collapsed. `id` is the first event's id.
	case updates(id: String, items: [TimelineItem])

	public var id: String {
		switch self {
		case .day(let id, _): "day-\(id)"
		case .item(let item): item.id
		case .updates(let id, _): "updates-\(id)"
		}
	}
}

public enum TimelineGrouping {
	/// Runs of system events at least this long fold into "n updates".
	public static let collapseThreshold = 3

	/// Day headings between the items (items without a date stay with the day before), and runs of
	/// `collapseThreshold` or more consecutive system events folded into one row. Comments are
	/// never folded.
	public static func rows(
		_ items: [TimelineItem], now: Date = Date(), calendar: Calendar = .current
	) -> [TimelineRowModel] {
		var out: [TimelineRowModel] = []
		var run: [TimelineItem] = []
		var lastDay: Date?

		func flush() {
			if run.count >= collapseThreshold, let first = run.first {
				out.append(.updates(id: first.id, items: run))
			} else {
				out.append(contentsOf: run.map { .item($0) })
			}
			run = []
		}

		for item in items {
			if let date = item.date {
				let day = calendar.startOfDay(for: date)
				if lastDay != day {
					flush()
					out.append(
						.day(id: "\(Int(day.timeIntervalSince1970))",
							label: ThreadLayout.dayLabel(day, now: now, calendar: calendar)))
					lastDay = day
				}
			}
			if case .activity = item.kind, item.delivery == .sent {
				run.append(item)
			} else {
				flush()
				out.append(.item(item))
			}
		}
		flush()
		return out
	}
}
