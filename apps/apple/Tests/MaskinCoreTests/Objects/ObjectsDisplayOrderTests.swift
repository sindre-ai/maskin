import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("Items Display: order, reset")
struct ObjectsDisplayOrderTests {
	private func makeStore() -> (ObjectsStore, FakeObjectsRemote) {
		let remote = FakeObjectsRemote(objects: Fixtures.objects)
		let directory = ObjectsDirectory(remote: remote, actors: Fixtures.actors)
		return (ObjectsStore(remote: remote, directory: directory, displayStorage: InMemoryObjectsDisplayStorage()), remote)
	}

	private func pageQueries(_ remote: FakeObjectsRemote) -> [ObjectsQuery] {
		remote.listQueries.filter { $0.limit == ObjectsStore.pageSize }
	}

	@Test("the needs-you sort ignores Order; the others flip with it")
	func reversedAppliesToDatedSorts() {
		var display = ObjectsDisplay(reversed: true)
		#expect(!display.isReversed)
		#expect(!display.isCustomised)
		display.sort = .name
		#expect(display.isReversed)
		#expect(display.isCustomised)
		#expect(display.serverOrder == ServerOrder(field: "title", ascending: false))
		display.sort = .updated
		#expect(display.serverOrder == ServerOrder(field: "updatedAt", ascending: true))
	}

	@Test("choices saved before Order existed still decode")
	func decodesLegacy() throws {
		let data = Data(#"{"sort":"name","needsYouOnly":false}"#.utf8)
		let display = try JSONDecoder().decode(ObjectsDisplay.self, from: data)
		#expect(display.sort == .name)
		#expect(!display.reversed)
	}

	@Test("sorting reversed returns the opposite order")
	func sorterReversed() {
		let objects = [
			WorkObject(id: "a", type: "task", title: "Alpha", status: "todo"),
			WorkObject(id: "b", type: "task", title: "Beta", status: "todo"),
		]
		#expect(ObjectsSorter.sorted(objects, by: .name, reversed: false).map(\.id) == ["a", "b"])
		#expect(ObjectsSorter.sorted(objects, by: .name, reversed: true).map(\.id) == ["b", "a"])
		#expect(
			ObjectsSorter.sorted(objects, by: .needsYou, reversed: true).map(\.id)
				== ObjectsSorter.sorted(objects, by: .needsYou).map(\.id))
	}

	@Test("Order asks the server for the opposite direction and persists")
	func orderRefetches() async {
		let (store, remote) = makeStore()
		await store.load()
		await store.setSort(.updated)
		let before = pageQueries(remote).count
		await store.setReversed(true)
		#expect(pageQueries(remote).count == before + 1)
		#expect(pageQueries(remote).last?.reversed == true)
		await store.setReversed(true)
		#expect(pageQueries(remote).count == before + 1)
	}

	@Test("Reset puts every display choice and the status filter back")
	func reset() async {
		let (store, _) = makeStore()
		await store.load()
		await store.setSort(.name)
		await store.setReversed(true)
		store.setGrouping(.type)
		store.setNeedsYouOnly(true)
		store.toggleProperty(.driver)
		await store.setStatus("todo")
		#expect(store.canResetDisplay)
		await store.resetDisplay()
		#expect(store.display == ObjectsDisplay(collapsed: store.display.collapsed))
		#expect(store.statusFilter == nil)
		#expect(!store.canResetDisplay)
	}
}
