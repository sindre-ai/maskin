import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

@MainActor
private func makeStore(
	_ remote: FakeObjectsRemote = FakeObjectsRemote(objects: Fixtures.objects)
) -> (ObjectsStore, FakeObjectsRemote) {
	let directory = ObjectsDirectory(remote: remote, actors: Fixtures.actors)
	return (ObjectsStore(remote: remote, directory: directory), remote)
}

@MainActor
@Suite("ObjectsStore")
struct ObjectsStoreTests {
	@Test("loads objects and groups them by status in the workspace's order")
	func loadsAndGroups() async {
		let (store, _) = makeStore()
		await store.load()
		#expect(store.phase == .loaded)
		#expect(store.objects.count == 5)
		store.grouping = .status
		let groups = store.groups
		// Schema order across types: insight statuses, then bet, then task.
		#expect(groups.map(\.id) == ["new", "active", "todo", "in_progress"])
		#expect(groups.first { $0.id == "in_progress" }?.objects.map(\.id) == ["t1", "t3"])
		store.grouping = .none
		#expect(store.groups.count == 1)
		#expect(store.groups[0].objects.map(\.id) == ["t1", "b1", "t2", "t3", "i1"])
	}

	@Test("groups by type in schema order, with a title and the type flag")
	func groupsByType() async {
		let (store, _) = makeStore()
		await store.load()
		store.grouping = .type
		#expect(store.groups.map(\.id) == ["insight", "bet", "task"])
		#expect(store.groups.map(\.title) == ["Insight", "Bet", "Task"])
		#expect(store.groups.allSatisfy { $0.isType })
	}

	@Test("groups by attention by default: processing, then needs you, never empty buckets")
	func groupsByAttention() async {
		let (store, _) = makeStore()
		await store.load()
		#expect(store.grouping == .attention)
		let ids = store.groups.map(\.id)
		#expect(ids == ids.filter { ["processing", "needs_you", "other"].contains($0) })
		#expect(ids == ["processing", "needs_you", "other"].filter(ids.contains))
		#expect(store.groups.flatMap(\.objects).count == store.objects.count)
	}

	@Test("within a type: needs-you first, then blocked, then active, then done")
	func typeGroupOrder() {
		let objects = [
			WorkObject(id: "done", type: "task", status: "done", updatedAt: Date(timeIntervalSince1970: 9)),
			WorkObject(id: "active", type: "task", status: "in_progress", updatedAt: Date(timeIntervalSince1970: 8)),
			WorkObject(id: "review", type: "task", status: "in_review", updatedAt: Date(timeIntervalSince1970: 1)),
			WorkObject(id: "unread", type: "task", status: "todo", updatedAt: Date(timeIntervalSince1970: 0), unreadCount: 2),
			WorkObject(id: "active2", type: "task", status: "todo", updatedAt: Date(timeIntervalSince1970: 7)),
		]
		let group = ObjectsGrouper.group(objects, by: .type, schema: .fallback, type: nil)
		#expect(group.count == 1)
		#expect(group[0].objects.map(\.id) == ["unread", "review", "active", "active2", "done"])
	}

	@Test("filter pills offer only the types present and keep them once one is chosen")
	func presentTypes() async {
		let remote = FakeObjectsRemote(objects: Fixtures.objects.filter { $0.type != "bet" })
		let (store, _) = makeStore(remote)
		#expect(store.presentTypes == ["insight", "bet", "task"])  // nothing loaded yet
		await store.load()
		#expect(store.presentTypes == ["insight", "task"])
		await store.setType("task")
		#expect(store.presentTypes == ["insight", "task"])
	}

	@Test("type filter is sent to the server and clears a status that no longer applies")
	func typeFilter() async {
		let (store, remote) = makeStore()
		await store.load()
		await store.setStatus("todo")
		await store.setType("bet")
		#expect(remote.listQueries.last?.type == "bet")
		#expect(store.statusFilter == nil)
		#expect(store.objects.map(\.id) == ["b1"])
		#expect(store.isFiltered)
	}

	@Test("search goes to the server and shows no matches as an empty loaded list")
	func search() async {
		let (store, remote) = makeStore()
		await store.load()
		await store.setSearch("push")
		#expect(remote.listQueries.last?.search == "push")
		#expect(store.objects.map(\.id) == ["i1"])
		await store.setSearch("zzz")
		#expect(store.objects.isEmpty)
		#expect(store.phase == .loaded)
		await store.setSearch("")
		#expect(store.objects.count == 5)
	}

	@Test("starred-only narrows the list to starred objects and keeps paging for them")
	func starredOnly() async {
		var many = (0..<75).map {
			WorkObject(id: "o\($0)", type: "task", title: "Task \($0)", status: "todo", updatedAt: Fixtures.date($0))
		}
		many[60].isStarred = true
		let (store, _) = makeStore(FakeObjectsRemote(objects: many))
		await store.load()
		await store.setStarredOnly(true)
		#expect(store.isFiltered)
		#expect(store.visibleObjects.map(\.id) == ["o60"])
		#expect(store.groups.flatMap(\.objects).map(\.id) == ["o60"])
		await store.setStarredOnly(false)
		#expect(store.visibleObjects.count == store.objects.count)
	}

	@Test("paginates: full page means more, loadMore appends without duplicates")
	func pagination() async {
		let many = (0..<75).map {
			WorkObject(id: "o\($0)", type: "task", title: "Task \($0)", status: "todo", updatedAt: Fixtures.date($0))
		}
		let (store, remote) = makeStore(FakeObjectsRemote(objects: many))
		await store.load()
		#expect(store.objects.count == 50)
		#expect(store.hasMore)
		await store.loadMore()
		#expect(remote.listQueries.last?.offset == 50)
		#expect(store.objects.count == 75)
		#expect(!store.hasMore)
		await store.loadMore()
		#expect(store.objects.count == 75)
	}

	@Test("live refresh never asks for more than the server cap, even with >100 rows paged in")
	func refreshStaysUnderServerCap() async {
		let many = (0..<250).map {
			WorkObject(id: "o\($0)", type: "task", title: "Task \($0)", status: "todo", updatedAt: Fixtures.date($0))
		}
		let (store, remote) = makeStore(FakeObjectsRemote(objects: many))
		await store.load()
		for _ in 0..<3 { await store.loadMore() }
		#expect(store.objects.count == 200)
		await store.refreshInPlace()
		#expect(remote.listQueries.allSatisfy { $0.limit <= ServerLimits.maxPageSize })
		#expect(store.objects.count == 200)
		#expect(store.objects.map(\.id) == many.prefix(200).map(\.id))
		#expect(store.hasMore)
		#expect(store.actionError == nil)
	}

	@Test("a failed live refresh with rows on screen is surfaced, not swallowed")
	func refreshFailureSurfaces() async {
		let (store, remote) = makeStore()
		await store.load()
		remote.fail("list")
		await store.refreshInPlace()
		#expect(store.actionError != nil)
		#expect(!store.objects.isEmpty)
	}

	@Test("a failed first load reports the error and offline state")
	func failedLoad() async {
		let (store, remote) = makeStore()
		remote.goOffline(true)
		remote.fail("list")
		await store.load()
		#expect(store.phase == .failed("You're offline."))
		#expect(store.isOffline)
		remote.heal()
		await store.load()
		#expect(store.phase == .loaded)
		#expect(!store.isOffline)
	}

	@Test("star is optimistic and rolls back when the server refuses")
	func starRollback() async {
		let (store, remote) = makeStore()
		await store.load()
		await store.toggleStar("t1")
		#expect(store.objects.first { $0.id == "t1" }?.isStarred == true)
		remote.fail("star")
		await store.toggleStar("t1")
		#expect(store.objects.first { $0.id == "t1" }?.isStarred == true)
		#expect(store.actionError == "boom")
	}

	@Test("delete removes optimistically and restores the row on failure")
	func deleteRollback() async {
		let (store, remote) = makeStore()
		await store.load()
		let before = store.objects.map(\.id)
		remote.fail("delete")
		await store.delete("t2")
		#expect(store.objects.map(\.id) == before)
		#expect(store.actionError != nil)
		remote.heal()
		await store.delete("t2")
		#expect(!store.objects.contains { $0.id == "t2" })
		#expect(store.actionError == nil)
	}

	@Test("create inserts at the top, but only when it matches the active filters")
	func create() async {
		let (store, _) = makeStore()
		await store.load()
		await store.setType("bet")
		let task = await store.create(ObjectDraft(type: "task", title: "Elsewhere", status: "todo"))
		#expect(task != nil)
		#expect(!store.objects.contains { $0.title == "Elsewhere" })
		let bet = await store.create(ObjectDraft(type: "bet", title: "Mine", status: "signal"))
		#expect(store.objects.first?.id == bet?.id)
	}

	@Test("an object event refreshes the list in place; deletes drop the row immediately")
	func eventRefresh() async throws {
		let (store, remote) = makeStore()
		await store.load()
		let (stream, continuation) = AsyncStream<HubSignal>.makeStream()
		let task = Task { await store.observe(stream) }

		remote.objects.insert(
			WorkObject(id: "n1", type: "task", title: "Fresh from an agent", status: "todo", updatedAt: Fixtures.date(0)),
			at: 0)
		continuation.yield(.event(WorkspaceEvent(id: "1", action: "created", entityType: .object, entityId: "n1")))
		try await waitUntil { store.objects.contains { $0.id == "n1" } }

		continuation.yield(.event(WorkspaceEvent(id: "2", action: "deleted", entityType: .object, entityId: "t1")))
		try await waitUntil { !store.objects.contains { $0.id == "t1" } }

		// Unrelated entity types don't refetch.
		let calls = remote.listQueries.count
		continuation.yield(.event(WorkspaceEvent(id: "3", action: "updated", entityType: .conversation, entityId: "c")))
		continuation.yield(.reconnected)
		try await waitUntil { remote.listQueries.count == calls + 1 }
		continuation.finish()
		await task.value
	}

	@Test("apply mirrors a detail edit, and drops the row if it leaves the status filter")
	func applyFromDetail() async {
		let (store, _) = makeStore()
		await store.load()
		var edited = store.objects.first { $0.id == "t2" }!
		edited.title = "Renamed"
		store.apply(edited)
		#expect(store.objects.first { $0.id == "t2" }?.title == "Renamed")
		await store.setStatus("todo")
		edited.status = "done"
		store.apply(edited)
		#expect(!store.objects.contains { $0.id == "t2" })
	}

	@Test("grouper puts unknown statuses last and skips empty groups")
	func grouperUnknown() {
		let objects = [
			WorkObject(id: "a", type: "task", status: "zeta"),
			WorkObject(id: "b", type: "task", status: "todo"),
		]
		let groups = ObjectsGrouper.group(objects, by: .status, schema: .fallback, type: "task")
		#expect(groups.map(\.id) == ["todo", "zeta"])
	}
	@Test("bulk star stars the picked objects and skips ones already starred")
	func bulkStar() async {
		let (store, _) = makeStore()
		await store.load()
		await store.toggleStar("t1")
		let result = await store.setStarred(["t1", "b1", "t2"], true)
		#expect(result == BulkResult(succeeded: 2, failed: 0))
		#expect(["t1", "b1", "t2"].allSatisfy { id in store.objects.first { $0.id == id }?.isStarred == true })
	}

	@Test("bulk status changes only objects whose type offers it, one idempotency key each")
	func bulkStatus() async {
		let (store, remote) = makeStore()
		await store.load()
		let result = await store.setStatus(["t1", "t2", "i1"], to: "done")
		let moved = store.objects.filter { $0.status == "done" }.map(\.id)
		#expect(result.failed == 0)
		#expect(result.succeeded == moved.count)
		#expect(Set(remote.updateKeys).count == remote.updateKeys.count)
	}

	@Test("bulk delete removes them, and puts them all back with a notice when it fails")
	func bulkDelete() async {
		let (store, remote) = makeStore()
		await store.load()
		remote.fail("delete")
		let failed = await store.delete(["t1", "b1"])
		#expect(failed == BulkResult(succeeded: 0, failed: 2))
		#expect(store.objects.count == 5)
		#expect(store.actionError == "Couldn't delete 2 objects.")
		remote.heal()
		let ok = await store.delete(["t1", "b1"])
		#expect(ok == BulkResult(succeeded: 2, failed: 0))
		#expect(store.objects.map(\.id).sorted() == ["i1", "t2", "t3"])
	}
}

/// Polls on the main actor until `condition` holds (events cross an AsyncStream hop).
@MainActor
func waitUntil(timeout: Duration = .seconds(15), _ condition: () -> Bool) async throws {
	let deadline = ContinuousClock.now + timeout
	while !condition() {
		if ContinuousClock.now > deadline { throw TimeoutError() }
		try await Task.sleep(for: .milliseconds(10))
	}
}

struct TimeoutError: Error {}
