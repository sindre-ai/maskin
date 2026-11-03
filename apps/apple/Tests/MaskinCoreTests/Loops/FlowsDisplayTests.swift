import Foundation
import Testing

@testable import MaskinCore

private let now = Date(timeIntervalSince1970: 1_800_000_000)

private func row(
	_ id: String, status: LoopPill = .learning, waiting: Int = 0, days: Double = 0, name: String? = nil
) -> LoopSummary {
	LoopSummary(
		id: id, name: name ?? id, status: status, waitingCount: waiting,
		updatedAt: now.addingTimeInterval(-days * 86400))
}

@MainActor
@Suite("Flows Display")
struct FlowsDisplayTests {
	private func store(_ loops: [LoopSummary], storage: (any LoopsDisplayStorage)? = nil) async -> LoopsStore {
		let store = LoopsStore(api: FakeLoopsAPI(loops), events: nil, displayStorage: storage)
		await store.refresh()
		return store
	}

	@Test("Needs you first lifts waiting flows, then keeps most recent first")
	func needsYouFirst() {
		let loops = [row("a", days: 1), row("b", waiting: 1, days: 5), row("c", days: 0)]
		#expect(LoopsSort.needsYouFirst.apply(to: loops).map(\.id) == ["b", "c", "a"])
		#expect(LoopsSort.recent.title == "Default")
	}

	@Test("Reversed flips the chosen order")
	func reversed() {
		let loops = [row("a", days: 1), row("b", days: 2)]
		#expect(LoopsSort.recent.apply(to: loops, reversed: true).map(\.id) == ["b", "a"])
	}

	@Test("the Show filter maps onto the needs-you and running flags")
	func filterMapping() async {
		let loops = [
			row("run", status: .learning), row("wait", status: .supervised, waiting: 2),
			row("off", status: .paused),
		]
		let store = await store(loops)
		#expect(store.filter == .everything)
		#expect(store.filtered().count == 3)
		store.filter = .running
		#expect(Set(store.filtered().map(\.id)) == ["run", "wait"])
		store.filter = .needsYou
		#expect(store.filtered().map(\.id) == ["wait"])
		#expect(store.needsYouOnly && !store.runningOnly)
		store.needsYouOnly = false
		#expect(store.filter == .everything)
	}

	@Test("Order and Summary persist, and Reset restores every default")
	func persistAndReset() async {
		let storage = InMemoryLoopsDisplayStorage()
		let store = await store([row("a")], storage: storage)
		#expect(!store.isDisplayCustomised)
		store.display.reversed = true
		store.display.showsSummary = false
		store.sort = .name
		store.filter = .running
		#expect(storage.load() == LoopsDisplay(reversed: true, showsSummary: false))
		#expect(store.isDisplayCustomised)
		store.resetDisplay()
		#expect(!store.isDisplayCustomised)
		#expect(storage.load() == LoopsDisplay())
	}
}
