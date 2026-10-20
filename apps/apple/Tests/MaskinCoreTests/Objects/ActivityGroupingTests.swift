import Foundation
import Testing

@testable import MaskinCore

private var cal: Calendar {
	var c = Calendar(identifier: .gregorian)
	c.timeZone = TimeZone(secondsFromGMT: 0)!
	return c
}

private let gb = Locale(identifier: "en_GB")

/// A Wednesday at noon UTC (2026-10-07).
private let noon = Date(timeIntervalSince1970: 1_791_374_400)

private func item(
	_ id: String, _ kind: TimelineItem.Kind, hoursAgo: Double, eventId: Int? = nil, parent: Int? = nil,
	actor: String? = nil
) -> TimelineItem {
	var item = TimelineItem(
		id: id, kind: kind, actorId: actor, date: noon.addingTimeInterval(-hoursAgo * 3600), delivery: .sent,
		eventId: eventId)
	item.parentEventId = parent
	return item
}

private let longText = String(repeating: "Reconnect is flaky on cellular handoff; adding backoff with jitter. ", count: 3)

@Suite("ActivityGrouping")
struct ActivityGroupingTests {
	@Test("day labels: Today, Yesterday, weekday within six days, then a date")
	func dayLabels() {
		func label(daysAgo: Int) -> String {
			ActivityGrouping.dayLabel(cal.date(byAdding: .day, value: -daysAgo, to: noon)!, now: noon, calendar: cal, locale: gb)
		}
		#expect(label(daysAgo: 0) == "Today")
		#expect(label(daysAgo: 1) == "Yesterday")
		#expect(label(daysAgo: 2) == "Mon")
		#expect(label(daysAgo: 6) == "Thu")
		// ICU abbreviates September as "Sep" or "Sept" depending on the OS; the shape is what matters.
		#expect(label(daysAgo: 7).hasPrefix("30 Sep"))
		#expect(!label(daysAgo: 7).contains("2026"))
		#expect(label(daysAgo: 400).hasPrefix("2 Sep"))
		#expect(label(daysAgo: 400).hasSuffix("2025"))
	}

	@Test("the day boundary is the local midnight, not 24 hours")
	func dayBoundary() {
		// 11:59 the day before noon-today is 24h01m ago: Yesterday, not two days.
		let justBeforeMidnight = cal.startOfDay(for: noon).addingTimeInterval(-60)
		#expect(ActivityGrouping.dayLabel(justBeforeMidnight, now: noon, calendar: cal, locale: gb) == "Yesterday")
		let justAfterMidnight = cal.startOfDay(for: noon).addingTimeInterval(60)
		#expect(ActivityGrouping.dayLabel(justAfterMidnight, now: noon, calendar: cal, locale: gb) == "Today")
	}

	@Test("times show only for today")
	func times() {
		#expect(ActivityGrouping.timeLabel(noon.addingTimeInterval(-3600), now: noon, calendar: cal, locale: gb) == "11:00")
		#expect(ActivityGrouping.timeLabel(noon.addingTimeInterval(-30 * 3600), now: noon, calendar: cal, locale: gb) == nil)
		#expect(ActivityGrouping.timeLabel(nil, now: noon, calendar: cal, locale: gb) == nil)
	}

	@Test("every authored comment is a message, however short; system events stay quiet lines")
	func commentKind() {
		let short = TimelineItem(id: "s", kind: .comment("ok"))
		let long = TimelineItem(id: "o", kind: .comment(String(repeating: "a", count: 500)))
		let system = TimelineItem(id: "e", kind: .activity(String(repeating: "moved ", count: 40)))
		#expect(ActivityGrouping.kind(of: short) == .comment)
		#expect(ActivityGrouping.kind(of: long) == .comment)
		#expect(ActivityGrouping.kind(of: system) == .event)
	}

	@Test("summary flattens a remark to one line and keeps a system summary as is")
	func summary() {
		#expect(ActivityGrouping.summary(of: TimelineItem(id: "a", kind: .activity("moved status to active"))) == "moved status to active")
		#expect(ActivityGrouping.summary(of: TimelineItem(id: "b", kind: .comment("Great,\n\nship it."))) == "Great, ship it.")
	}

	@Test("days come newest first with newest items first, and each day is labelled")
	func grouping() {
		let days = ActivityGrouping.days(
			[
				item("old", .activity("created task"), hoursAgo: 50, eventId: 1),
				item("y", .comment(longText), hoursAgo: 26, eventId: 2),
				item("t1", .activity("moved status"), hoursAgo: 3, eventId: 3),
				item("t2", .comment("ok"), hoursAgo: 1, eventId: 4),
			], now: noon, calendar: cal, locale: gb)
		#expect(days.map(\.label) == ["Today", "Yesterday", "Mon"])
		#expect(days[0].entries.map(\.id) == ["t2", "t1"])
		#expect(days[0].entries.map(\.kind) == [.comment, .event])
		#expect(days[0].entries[0].timeLabel == "11:00")
		#expect(days[1].entries[0].kind == .comment)
		#expect(days[1].entries[0].timeLabel == nil)
	}

	@Test("a reply to a reply stays in the same thread under the top-level message")
	func nestedReplies() {
		let days = ActivityGrouping.days(
			[
				item("root", .comment(longText), hoursAgo: 5, eventId: 10),
				item("r1", .comment("First reply"), hoursAgo: 4, eventId: 11, parent: 10),
				item("r2", .comment("Reply to the reply"), hoursAgo: 3, eventId: 12, parent: 11),
			], now: noon, calendar: cal, locale: gb)
		#expect(days.flatMap(\.entries).map(\.id) == ["root"])
		#expect(days[0].entries[0].replies.map(\.id) == ["r1", "r2"])
	}

	@Test("replies nest under their parent, oldest first, and never start their own day")
	func replies() {
		let days = ActivityGrouping.days(
			[
				item("root", .comment(longText), hoursAgo: 30, eventId: 10),
				item("r2", .comment("Second reply"), hoursAgo: 1, eventId: 12, parent: 10),
				item("r1", .comment("First reply"), hoursAgo: 2, eventId: 11, parent: 10),
				item("other", .activity("moved status"), hoursAgo: 0.5, eventId: 13),
			], now: noon, calendar: cal, locale: gb)
		#expect(days.map(\.label) == ["Today", "Yesterday"])
		#expect(days[0].entries.map(\.id) == ["other"])
		let root = days[1].entries[0]
		#expect(root.id == "root")
		#expect(root.replies.map(\.id) == ["r1", "r2"])
		#expect(root.replies[0].timeLabel == "10:00")
	}

	@Test("a reply whose parent is not on the page stays top level; a local unsent reply still nests")
	func orphanAndLocalReplies() {
		var local = TimelineItem(id: "local-1", kind: .comment("Sending…"), date: noon, delivery: .sending)
		local.parentEventId = 10
		let days = ActivityGrouping.days(
			[
				item("root", .comment(longText), hoursAgo: 3, eventId: 10),
				item("orphan", .comment("Where is my parent"), hoursAgo: 2, eventId: 20, parent: 99),
				local,
			], now: noon, calendar: cal, locale: gb)
		#expect(days.count == 1)
		#expect(days[0].entries.map(\.id) == ["orphan", "root"])
		#expect(days[0].entries[1].replies.map(\.id) == ["local-1"])
	}

	@Test("items without a date ride with the newest day instead of inventing one")
	func undated() {
		let dated = item("a", .activity("created"), hoursAgo: 2, eventId: 1)
		let undated = TimelineItem(id: "u", kind: .comment("hi"))
		let days = ActivityGrouping.days([dated, undated], now: noon, calendar: cal, locale: gb)
		#expect(days.count == 1)
		#expect(days[0].entries.map(\.id).contains("u"))
	}
}

@Suite("DescriptionCollapse")
struct DescriptionCollapseTests {
	@Test("folds past 520 characters, never under")
	func threshold() {
		#expect(!DescriptionCollapse.collapses(String(repeating: "a", count: 520)))
		#expect(DescriptionCollapse.collapses(String(repeating: "a", count: 521)))
		#expect(!DescriptionCollapse.collapses(""))
	}

	@Test("reading time is whole minutes at 200 words a minute, never under one")
	func readingTime() {
		#expect(DescriptionCollapse.readingMinutes("a few words") == 1)
		#expect(DescriptionCollapse.readingMinutes(Array(repeating: "word", count: 200).joined(separator: " ")) == 1)
		#expect(DescriptionCollapse.readingMinutes(Array(repeating: "word", count: 201).joined(separator: " ")) == 2)
		#expect(DescriptionCollapse.readAllLabel(Array(repeating: "word", count: 450).joined(separator: " ")) == "Read all · 3 min")
	}
}

@Suite("RelatedGrouping")
struct RelatedGroupingTests {
	private func link(_ id: String, _ relation: String, out: Bool, type: String = "task") -> ObjectLink {
		ObjectLink(id: id, relation: relation, isOutgoing: out, otherId: "o-\(id)", otherType: type, otherTitle: "T \(id)")
	}

	@Test("groups by sentence-cased phrase in first-seen order, with the flow first")
	func groups() {
		let groups = RelatedGrouping.groups([
			link("a", "blocks", out: true), link("b", "breaks_into", out: false), link("c", "blocks", out: true),
			link("d", "relates_to", out: true, type: "loop"),
		])
		#expect(groups.map(\.label) == ["In flow", "Blocking", "Belongs to"])
		#expect(groups[1].links.map(\.id) == ["a", "c"])
	}

	@Test("excluded ids (attached files) are left out")
	func excludes() {
		let groups = RelatedGrouping.groups([link("a", "attached", out: true, type: "file")], excluding: ["o-a"])
		#expect(groups.isEmpty)
	}
}
