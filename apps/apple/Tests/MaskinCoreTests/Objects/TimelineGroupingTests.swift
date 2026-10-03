import Foundation
import Testing

@testable import MaskinCore

private var cal: Calendar {
	var c = Calendar(identifier: .gregorian)
	c.timeZone = TimeZone(secondsFromGMT: 0)!
	return c
}

private let noon = Date(timeIntervalSince1970: Double(1_790_000_000 - 1_790_000_000 % 86_400 + 12 * 3600))

private func item(_ id: String, _ kind: TimelineItem.Kind, hoursAgo: Double) -> TimelineItem {
	TimelineItem(
		id: id, kind: kind, actorId: nil, date: noon.addingTimeInterval(-hoursAgo * 3600), delivery: .sent,
		eventId: nil)
}

@Suite("TimelineGrouping")
struct TimelineGroupingTests {
	@Test("a heading starts each day")
	func days() {
		let rows = TimelineGrouping.rows(
			[item("a", .comment("x"), hoursAgo: 30), item("b", .comment("y"), hoursAgo: 1)],
			now: noon, calendar: cal)
		let labels = rows.compactMap { if case .day(_, let l) = $0 { l } else { nil } }
		#expect(labels.count == 2)
		#expect(labels.last == "Today")
	}

	@Test("three or more system events in a row fold into one row")
	func collapses() {
		let events = (0..<4).map { item("e\($0)", .activity("moved"), hoursAgo: 3 - Double($0) * 0.1) }
		let rows = TimelineGrouping.rows(events, now: noon, calendar: cal)
		#expect(rows.count == 2)  // day + folded run
		if case .updates(_, let items) = rows[1] { #expect(items.count == 4) } else { Issue.record("not folded") }
	}

	@Test("two system events and any comment stay as they are")
	func keepsShortRunsAndComments() {
		let rows = TimelineGrouping.rows(
			[
				item("e1", .activity("a"), hoursAgo: 3), item("e2", .activity("b"), hoursAgo: 2.9),
				item("c", .comment("hi"), hoursAgo: 2.8),
			], now: noon, calendar: cal)
		#expect(rows.count == 4)  // day + 3 items
	}
}
