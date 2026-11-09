import Foundation
import MaskinCore
import Testing

@testable import MaskinFeatures

@Suite("ActivityPhases")
struct ActivityPhasesTests {
	private func item(_ n: Int, move: (String?, String)? = nil) -> TimelineItem {
		var i = TimelineItem(
			id: "e-\(n)", kind: .activity("x"), date: Date(timeIntervalSince1970: Double(n)), eventId: n)
		i.statusChange = move.map { TimelineItem.StatusChange(from: $0.0, to: $0.1) }
		return i
	}

	@Test("an item sits in the status the latest earlier move set; earlier ones in the first move's from")
	func statuses() {
		let items = [item(1), item(2, move: ("proposed", "review")), item(3), item(4, move: ("review", "done")), item(5)]
		let s = ActivityPhases.statuses(of: items)
		#expect(s["e-1"] == "proposed")
		#expect(s["e-2"] == "review")
		#expect(s["e-3"] == "review")
		#expect(s["e-5"] == "done")
	}

	@Test("no status move means no phases")
	func none() {
		#expect(ActivityPhases.statuses(of: [item(1), item(2)]).isEmpty)
	}

	@Test("a divider goes under the oldest entry of each phase, newest first")
	func dividers() {
		let statuses = ["e-5": "done", "e-4": "done", "e-3": "review", "e-2": "review", "e-1": "proposed"]
		let d = ActivityPhases.dividers(newestFirst: ["e-5", "e-4", "e-3", "e-2", "e-1"], statuses: statuses)
		#expect(d == ["e-4": "done", "e-2": "review", "e-1": "proposed"])
	}

	@MainActor @Test("reads the diff shape and the older snapshot shape")
	func parse() {
		let diff: JSONValue = .object(["changes": .array([
			.object(["field": .string("title"), "old": .string("a"), "new": .string("b")]),
			.object(["field": .string("status"), "old": .string("todo"), "new": .string("done")]),
		])])
		#expect(ObjectDetailStore.statusChange(in: diff) == .init(from: "todo", to: "done"))
		let legacy: JSONValue = .object([
			"previous": .object(["status": .string("todo")]), "updated": .object(["status": .string("done")]),
		])
		#expect(ObjectDetailStore.statusChange(in: legacy) == .init(from: "todo", to: "done"))
		#expect(ObjectDetailStore.statusChange(in: .object(["changes": .array([])])) == nil)
	}
}
