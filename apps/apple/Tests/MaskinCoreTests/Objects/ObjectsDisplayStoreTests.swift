import Foundation
import Testing

@testable import MaskinCore

@MainActor
private func makeStore(
	_ objects: [WorkObject] = Fixtures.objects, storage: (any ObjectsDisplayStorage)? = nil
) -> (ObjectsStore, FakeObjectsRemote) {
	let remote = FakeObjectsRemote(objects: objects)
	let directory = ObjectsDirectory(remote: remote, actors: Fixtures.actors)
	return (ObjectsStore(remote: remote, directory: directory, displayStorage: storage), remote)
}

@MainActor
@Suite("ObjectsStore display")
struct ObjectsDisplayStoreTests {
	@Test("choices are saved and come back on the next launch")
	func persists() async {
		let storage = InMemoryObjectsDisplayStorage()
		let (store, _) = makeStore(storage: storage)
		await store.setSort(.updated)
		store.setNeedsYouOnly(true)
		store.toggleProperty(.driver)
		let (relaunched, _) = makeStore(storage: storage)
		#expect(relaunched.display.sort == .updated)
		#expect(relaunched.display.needsYouOnly)
		#expect(!relaunched.display.shows(.driver))
	}

	@Test("Name asks the server for title order; Needs you and Updated both page by update time")
	func serverSort() async {
		let (store, remote) = makeStore()
		await store.load()
		#expect(remote.listQueries.last?.sort == .needsYou)
		await store.setSort(.name)
		#expect(remote.listQueries.last?.sort == .name)
		let queriesAfterName = remote.listQueries.count
		await store.setSort(.updated)
		#expect(remote.listQueries.last?.sort == .updated)
		// Between the two update-time orders nothing is refetched: the tiers are local.
		let (other, otherRemote) = makeStore()
		await other.load()
		let loaded = otherRemote.listQueries.count
		await other.setSort(.updated)
		#expect(otherRemote.listQueries.count == loaded)
		#expect(queriesAfterName >= 2)
	}

	@Test("Needs you only keeps what wants the person")
	func needsYouOnly() async {
		let objects = [
			WorkObject(id: "a", type: "task", title: "A", status: "in_progress"),
			WorkObject(id: "b", type: "task", title: "B", status: "in_review"),
			WorkObject(id: "c", type: "task", title: "C", status: "todo", unreadCount: 2),
		]
		let (store, _) = makeStore(objects)
		await store.load()
		#expect(store.visibleObjects.count == 3)
		store.setNeedsYouOnly(true)
		#expect(Set(store.visibleObjects.map(\.id)) == ["b", "c"])
		#expect(store.groups.flatMap(\.objects).count == 2)
	}

	@Test("the groups follow the chosen sort")
	func groupsFollowSort() async {
		let objects = [
			WorkObject(id: "z", type: "task", title: "Zeta", status: "todo", updatedAt: Fixtures.date(1)),
			WorkObject(id: "a", type: "task", title: "Alpha", status: "todo", updatedAt: Fixtures.date(50)),
		]
		let (store, _) = makeStore(objects)
		await store.load()
		#expect(store.groups[0].objects.map(\.id) == ["z", "a"])
		await store.setSort(.name)
		#expect(store.groups[0].objects.map(\.id) == ["a", "z"])
	}

	@Test("opening the board from All lands on the first present type")
	func boardPicksAType() async {
		let (store, _) = makeStore()
		await store.load()
		#expect(store.typeFilter == nil)
		await store.setLayout(.board)
		#expect(store.display.layout == .board)
		#expect(store.typeFilter == "insight")
		await store.setLayout(.list)
		#expect(store.typeFilter == "insight")
	}
}

@MainActor
@Suite("ObjectsBoardStore")
struct ObjectsBoardStoreTests {
	private func board(_ objects: [WorkObject] = Fixtures.objects) -> (ObjectsBoardStore, FakeObjectsRemote) {
		let remote = FakeObjectsRemote(objects: objects)
		return (ObjectsBoardStore(remote: remote), remote)
	}

	@Test("loads one type's columns in the workflow's order and hides the empty ones")
	func columns() async {
		let (store, remote) = board()
		await store.load(type: "task", sort: .needsYou)
		#expect(store.phase == .loaded)
		#expect(remote.boardQueries.first?.type == "task")
		#expect(store.columns.map(\.value) == ["backlog", "todo", "in_progress", "in_review", "validated", "done", "discarded"])
		#expect(store.shownColumns.map(\.value) == ["todo", "in_progress"])
		#expect(store.shownColumns.first { $0.value == "in_progress" }?.total == 2)
	}

	@Test("no type means no board")
	func noType() async {
		let (store, remote) = board()
		await store.load(type: nil, sort: .needsYou)
		#expect(store.columns.isEmpty)
		#expect(remote.boardQueries.isEmpty)
	}

	@Test("cards follow the sort and narrow to Needs you")
	func cards() async {
		let objects = [
			WorkObject(id: "z", type: "task", title: "Zeta", status: "todo", updatedAt: Fixtures.date(1)),
			WorkObject(id: "a", type: "task", title: "Alpha", status: "todo", updatedAt: Fixtures.date(50), unreadCount: 1),
		]
		let (store, _) = board(objects)
		await store.load(type: "task", sort: .name)
		let column = try! #require(store.shownColumns.first)
		#expect(store.cards(in: column, needsYouOnly: false).map(\.id) == ["a", "z"])
		#expect(store.cards(in: column, needsYouOnly: true).map(\.id) == ["a"])
		#expect(store.count(in: column, needsYouOnly: false) == 2)
		#expect(store.count(in: column, needsYouOnly: true) == 1)
	}

	@Test("a column pages on without duplicating or touching its neighbours")
	func loadMore() async {
		let many = (0..<25).map {
			WorkObject(id: "t\($0)", type: "task", title: "T\($0)", status: "todo", updatedAt: Fixtures.date($0))
		}
		let (store, remote) = board(many + [WorkObject(id: "p", type: "task", title: "P", status: "in_progress")])
		await store.load(type: "task", sort: .updated)
		let todo = try! #require(store.columns.first { $0.value == "todo" })
		#expect(todo.objects.count == ObjectsBoardStore.pageSize)
		#expect(todo.total == 25)
		#expect(todo.hasMore)
		await store.loadMore(column: todo.id)
		let after = try! #require(store.columns.first { $0.value == "todo" })
		#expect(after.objects.count == 25)
		#expect(Set(after.objects.map(\.id)).count == 25)
		#expect(!after.hasMore)
		#expect(remote.boardQueries.last?.column == "todo")
		#expect(remote.boardQueries.last?.offset == ObjectsBoardStore.pageSize)
		#expect(store.columns.first { $0.value == "in_progress" }?.objects.count == 1)
	}

	@Test("a failed first load says so; a failed refresh keeps the board")
	func failures() async {
		let (store, remote) = board()
		remote.fail("board")
		await store.load(type: "task", sort: .needsYou)
		if case .failed = store.phase {} else { Issue.record("expected failed, got \(store.phase)") }
		remote.heal()
		await store.refresh()
		#expect(store.phase == .loaded)
		remote.fail("board")
		await store.refresh()
		#expect(store.phase == .loaded)
		#expect(!store.columns.isEmpty)
	}

	@Test("a different type starts clean")
	func switchingType() async {
		let (store, _) = board()
		await store.load(type: "task", sort: .needsYou)
		await store.load(type: "bet", sort: .needsYou)
		#expect(store.type == "bet")
		#expect(store.columns.allSatisfy { _ in true })
		#expect(store.shownColumns.map(\.value) == ["active"])
	}
}
