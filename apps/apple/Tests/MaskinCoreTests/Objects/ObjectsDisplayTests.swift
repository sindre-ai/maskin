import Foundation
import Testing

@testable import MaskinCore

private func object(
	_ id: String, status: String, type: String = "task", minutesAgo: Int = 0, unread: Int = 0,
	title: String? = nil, active: Bool = false
) -> WorkObject {
	WorkObject(
		id: id, type: type, title: title ?? id, status: status,
		updatedAt: Date(timeIntervalSince1970: 1_800_000_000 - Double(minutesAgo * 60)),
		unreadCount: unread, hasActiveSession: active)
}

@Suite("Objects ordering")
struct ObjectsOrderingTests {
	@Test("within a type, the default order is needs you, blocked, active, done")
	func tiersByDefault() {
		let objects = [
			object("done", status: "done", minutesAgo: 1),
			object("active", status: "in_progress", minutesAgo: 2),
			object("paused", status: "paused", minutesAgo: 3),
			object("unread", status: "todo", minutesAgo: 90, unread: 1),
			object("review", status: "in_review", minutesAgo: 5),
		]
		let group = ObjectsGrouper.group(objects, by: .type, schema: .fallback, type: nil)
		#expect(group.count == 1)
		// unread ranks as needs-you; in_review and paused are the blocked tier.
		#expect(group[0].objects.map(\.id) == ["unread", "review", "paused", "active", "done"])
	}

	@Test("newest-updated breaks ties inside a tier")
	func newestWithinTier() {
		let objects = [
			object("old", status: "todo", minutesAgo: 60),
			object("new", status: "todo", minutesAgo: 1),
		]
		#expect(ObjectsSorter.sorted(objects, by: .needsYou).map(\.id) == ["new", "old"])
	}

	@Test("Updated ignores the tiers")
	func updatedIgnoresTiers() {
		let objects = [
			object("done-fresh", status: "done", minutesAgo: 1),
			object("unread-stale", status: "todo", minutesAgo: 600, unread: 3),
		]
		#expect(ObjectsSorter.sorted(objects, by: .updated).map(\.id) == ["done-fresh", "unread-stale"])
		#expect(ObjectsSorter.sorted(objects, by: .needsYou).map(\.id) == ["unread-stale", "done-fresh"])
	}

	@Test("Name sorts naturally and ignores case")
	func nameSort() {
		let objects = [
			object("a", status: "todo", title: "task 10"),
			object("b", status: "todo", title: "Task 2"),
			object("c", status: "todo", title: "alpha"),
		]
		#expect(ObjectsSorter.sorted(objects, by: .name).map(\.id) == ["c", "b", "a"])
	}

	@Test("the sort applies inside every grouping")
	func sortInsideGroups() {
		let objects = [
			object("z", status: "todo", type: "task", title: "Zeta"),
			object("a", status: "todo", type: "task", title: "Alpha"),
			object("b", status: "active", type: "bet", title: "Beta"),
		]
		let byType = ObjectsGrouper.group(objects, by: .type, schema: .fallback, type: nil, sort: .name)
		#expect(byType.map(\.id) == ["bet", "task"])
		#expect(byType[1].objects.map(\.id) == ["a", "z"])
		let flat = ObjectsGrouper.group(objects, by: .none, schema: .fallback, type: nil, sort: .name)
		#expect(flat[0].objects.map(\.id) == ["a", "b", "z"])
	}

	@Test("needs you means unread, a review to give, or a decision to make")
	func needsYouPredicate() {
		#expect(ObjectsUrgency.needsYou(object("a", status: "todo", unread: 1)))
		#expect(ObjectsUrgency.needsYou(object("b", status: "in_review")))
		#expect(ObjectsUrgency.needsYou(object("c", status: "waiting_for_input")))
		#expect(!ObjectsUrgency.needsYou(object("d", status: "in_progress")))
		#expect(!ObjectsUrgency.needsYou(object("e", status: "paused")))
		#expect(!ObjectsUrgency.needsYou(object("f", status: "done")))
	}

	@Test("status tone: Patina for running and needs you, ink for done, grey for paused")
	func statusTones() {
		#expect(ObjectsStatusTone.of(object("a", status: "in_progress")) == .patina)
		#expect(ObjectsStatusTone.of(object("b", status: "in_review")) == .patina)
		#expect(ObjectsStatusTone.of(object("c", status: "todo", active: true)) == .patina)
		#expect(ObjectsStatusTone.of(object("d", status: "done")) == .ink)
		#expect(ObjectsStatusTone.of(object("e", status: "paused")) == .quiet)
		#expect(ObjectsStatusTone.of(object("f", status: "archived")) == .quiet)
		#expect(ObjectsStatusTone.of(object("g", status: "todo")) == .neutral)
	}
}

@Suite("Objects display")
struct ObjectsDisplaySettingsTests {
	@Test("starts on Needs you, everything shown, as a list")
	func defaults() {
		let display = ObjectsDisplay()
		#expect(display.sort == .needsYou)
		#expect(!display.needsYouOnly)
		#expect(display.layout == .list)
		#expect(display.shows(.driver) && display.shows(.updated))
	}

	@Test("toggling a property flips only that property")
	func toggling() {
		var display = ObjectsDisplay()
		display.toggle(.driver)
		#expect(!display.shows(.driver))
		#expect(display.shows(.updated))
		display.toggle(.driver)
		#expect(display.shows(.driver))
	}

	@Test("survives a relaunch through user defaults")
	func userDefaultsRoundTrip() throws {
		let suite = "objects.display.tests.\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: suite))
		defer { defaults.removePersistentDomain(forName: suite) }
		let storage = UserDefaultsObjectsDisplayStorage(defaults: defaults)
		#expect(storage.load() == nil)
		let chosen = ObjectsDisplay(sort: .name, needsYouOnly: true, shown: [.updated], layout: .board)
		storage.save(chosen)
		#expect(UserDefaultsObjectsDisplayStorage(defaults: defaults).load() == chosen)
	}
}
