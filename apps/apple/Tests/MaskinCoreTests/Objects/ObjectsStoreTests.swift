import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

/// A throwaway `UserDefaults` so saved views never leak between tests.
private func isolatedDefaults() -> UserDefaults {
	UserDefaults(suiteName: "ObjectsStoreTests.\(UUID().uuidString)")!
}

@MainActor
private func makeStore(
	_ remote: FakeObjectsRemote = FakeObjectsRemote(objects: Fixtures.objects),
	defaults: UserDefaults = isolatedDefaults(), workspace: String? = "ws-1"
) -> (ObjectsStore, FakeObjectsRemote) {
	let directory = ObjectsDirectory(remote: remote, actors: Fixtures.actors)
	let store = ObjectsStore(remote: remote, directory: directory, defaults: defaults)
	store.bindWorkspace(workspace)
	return (store, remote)
}

private func ask(_ objectId: String, by name: String? = "Forge", text: String = "Ship it?") -> ObjectAsk {
	ObjectAsk(
		objectId: objectId, askedBy: name, text: text, parentEventId: 9, latestEventId: 12,
		options: [
			DecisionOption(label: "Ship", recommended: true), DecisionOption(label: "Hold"),
			DecisionOption(label: "Send to everyone", destructive: true),
		])
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
		#expect(store.grouping == .status)
		let groups = store.groups
		// Product order across types (Bets, Insights, Tasks), each type's own statuses under it.
		#expect(groups.map(\.id) == ["bet/active", "insight/new", "task/todo", "task/in_progress"])
		#expect(groups.first?.title == "Bets · Active")
		#expect(groups.first { $0.id == "task/in_progress" }?.objects.map(\.id) == ["t1", "t3"])
		store.grouping = .none
		#expect(store.groups.count == 1)
		#expect(store.groups[0].objects.map(\.id) == ["t1", "b1", "t2", "t3", "i1"])
	}

	@Test("groups by type in schema order, with a title and the type flag")
	func groupsByType() async {
		let (store, _) = makeStore()
		await store.load()
		store.grouping = .type
		#expect(store.groups.map(\.id) == ["bet", "insight", "task"])
		#expect(store.groups.map(\.title) == ["Bets", "Insights", "Tasks"])
		#expect(store.groups.allSatisfy { $0.isType })
	}

	@Test("groups by attention: processing, then needs you, never empty buckets")
	func groupsByAttention() async {
		let (store, _) = makeStore()
		await store.load()
		store.grouping = .attention
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
		#expect(store.presentTypes == ["bet", "insight", "task"])  // nothing loaded yet
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

		// Unrelated entity types don't refetch; a reconnect re-reads the list and the inventory.
		let calls = remote.listQueries.count
		continuation.yield(.event(WorkspaceEvent(id: "3", action: "updated", entityType: .conversation, entityId: "c")))
		continuation.yield(.reconnected)
		try await waitUntil { remote.listQueries.count == calls + 2 }
		#expect(Set(remote.listQueries.suffix(2).map(\.limit)) == [ObjectsStore.pageSize, ObjectsStore.inventoryLimit])
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

@MainActor
@Suite("ObjectsStore: scope, counts and needs you")
struct ObjectsStoreScopeTests {
	@Test("type summaries count the inventory per type in product order, with plural labels")
	func typeSummaries() async {
		let (store, _) = makeStore()
		await store.load()
		let summaries = store.typeSummaries
		#expect(summaries.map(\.id) == ["bet", "insight", "task"])
		#expect(summaries.map(\.label) == ["Bets", "Insights", "Tasks"])
		#expect(summaries.map(\.count) == [1, 1, 3])
		#expect(summaries.allSatisfy { !$0.isCapped })
		#expect(store.totalCount == 5)
		#expect(store.totalCountLabel == "5")
	}

	@Test("a full inventory page marks every count as a floor")
	func cappedInventory() async {
		let many = (0..<120).map {
			WorkObject(id: "o\($0)", type: "task", title: "Task \($0)", status: "todo", updatedAt: Fixtures.date($0))
		}
		let (store, _) = makeStore(FakeObjectsRemote(objects: many))
		await store.load()
		#expect(store.inventory.count == ObjectsStore.inventoryLimit)
		#expect(store.inventoryCapped)
		#expect(store.typeSummaries.first { $0.id == "task" }?.countLabel == "100+")
	}

	@Test("a full inventory keeps every configured type on offer, even one older than the newest page")
	func cappedInventoryKeepsConfiguredTypes() async {
		let many = (0..<120).map {
			WorkObject(id: "o\($0)", type: "task", title: "Task \($0)", status: "todo", updatedAt: Fixtures.date($0))
		}
		let (store, _) = makeStore(FakeObjectsRemote(objects: many))
		await store.load()
		#expect(store.inventoryCapped)
		#expect(store.presentTypes == ["bet", "insight", "task"])
	}

	@Test("needs you comes from an open ask or the data's own signals, and the Needs you scope shows only those")
	func needsYou() async {
		var objects = Fixtures.objects
		objects.append(WorkObject(id: "x1", type: "task", title: "Review the copy", status: "in_review", updatedAt: Fixtures.date(3)))
		let (store, _) = makeStore(FakeObjectsRemote(objects: objects))
		await store.load()
		#expect(store.needsYouCount == 1)
		store.applyAsks([ask("b1")])
		#expect(store.needsYouCount == 2)
		#expect(store.needsYou(store.objects.first { $0.id == "b1" }!))
		#expect(store.ask(for: "b1")?.line == "Forge: Ship it?")
		#expect(store.typeSummaries.first { $0.id == "bet" }?.needsYou == 1)
		#expect(store.typeSummaries.first { $0.id == "task" }?.needsYou == 1)

		await store.setScope(.needsYou)
		#expect(store.title == "Needs you")
		#expect(store.isFiltered)
		#expect(Set(store.visibleObjects.map(\.id)) == ["b1", "x1"])
		#expect(store.typeFilter == nil)
		#expect(store.groups.map(\.id) == ["bet/active", "task/in_review"])

		store.applyAsks([])
		#expect(store.visibleObjects.map(\.id) == ["x1"])
	}

	@Test("an ask without a resolved name never shows an id, and picks its options")
	func askLine() {
		#expect(ask("b1", by: nil).line == "Ship it?")
		let a = ask("b1")
		#expect(a.approveOption?.label == "Ship")
		#expect(a.holdOption?.label == "Hold")
		#expect(ObjectAsk(objectId: "z", askedBy: "Quill", text: "Ok?", options: [DecisionOption(label: "Send", destructive: true)]).approveOption == nil)
	}

	@Test("an ask is built from a feed entry that needs the reader, and not from an FYI")
	func askFromFeedEntry() {
		let card = ForYouCard(
			id: "b1", objectTitle: "Native iOS app", objectType: "bet", latestEventId: 40,
			mention: ForYouMention(
				eventId: 31, actorId: "forge", content: "ask",
				decision: DecisionPrompt(
					title: "Ship the beta to TestFlight?", summary: "", ask: "",
					options: [DecisionOption(label: "Ship", recommended: true)])))
		let needs = ObjectAsk(FeedEntry(card: card, bucket: .needs), senderName: "Forge")
		#expect(needs?.text == "Ship the beta to TestFlight?")
		#expect(needs?.parentEventId == 31)
		#expect(needs?.latestEventId == 40)
		#expect(needs?.options.count == 1)
		#expect(ObjectAsk(FeedEntry(card: card, bucket: .fyi), senderName: "Forge") == nil)
	}

	@Test("scopes map to the server filters and the large title")
	func scopes() async {
		let (store, remote) = makeStore()
		await store.load()
		#expect(store.title == "Objects")
		#expect(store.mixesTypes)
		await store.setScope(.type("insight"))
		#expect(store.title == "Insights")
		#expect(!store.mixesTypes)
		#expect(remote.listQueries.last?.type == "insight")
		#expect(store.objects.map(\.id) == ["i1"])
		await store.setScope(.favourites)
		#expect(store.title == "Favourites")
		#expect(store.starredOnly)
		#expect(store.typeFilter == nil)
		await store.setScope(.all)
		#expect(!store.isFiltered)
		#expect(store.objects.count == 5)
	}

	@Test("folded groups are remembered per grouping and persist")
	func foldPersists() async {
		let storage = InMemoryObjectsDisplayStorage()
		let remote = FakeObjectsRemote(objects: Fixtures.objects)
		let directory = ObjectsDirectory(remote: remote, actors: Fixtures.actors)
		let store = ObjectsStore(remote: remote, directory: directory, displayStorage: storage, defaults: isolatedDefaults())
		await store.load()
		store.toggleGroup("task/todo")
		#expect(store.display.isCollapsed("task/todo"))
		store.grouping = .type
		#expect(!store.display.isCollapsed("task/todo"))
		let again = ObjectsStore(remote: remote, directory: directory, displayStorage: storage, defaults: isolatedDefaults())
		#expect(again.display.groupBy == .type)
		again.grouping = .status
		#expect(again.display.isCollapsed("task/todo"))
	}
}

@MainActor
@Suite("ObjectsStore: saved views")
struct ObjectsStoreSavedViewsTests {
	@Test("saving the current view keeps its filters, switches to it and survives a relaunch")
	func saveAndReload() async {
		let defaults = isolatedDefaults()
		let (store, remote) = makeStore(defaults: defaults)
		await store.load()
		await store.setScope(.type("task"))
		await store.setStatus("in_progress")
		store.grouping = .none
		let view = store.saveCurrentView(named: "  Doing now ")
		#expect(view?.name == "Doing now")
		#expect(view?.scope == .type("task"))
		#expect(view?.statusFilter == "in_progress")
		#expect(view?.groupBy == ObjectsGrouping.none)
		#expect(store.scope == .saved(view!.id))
		#expect(store.title == "Doing now")
		#expect(store.count(of: view!) == 2)
		#expect(store.saveCurrentView(named: "   ") == nil)

		let (again, _) = makeStore(remote, defaults: defaults)
		await again.load()
		#expect(again.savedViews.views.map(\.name) == ["Doing now"])
		await again.setScope(.saved(view!.id))
		#expect(again.typeFilter == "task")
		#expect(again.statusFilter == "in_progress")
		#expect(again.display.groupBy == ObjectsGrouping.none)
		#expect(again.objects.map(\.id) == ["t1", "t3"])

		let (other, _) = makeStore(remote, defaults: defaults, workspace: "ws-2")
		#expect(other.savedViews.views.isEmpty)
	}

	@Test("removing a saved view hands back what restores it, in place")
	func removeAndRestore() async {
		let (store, _) = makeStore()
		await store.load()
		let a = store.saveCurrentView(named: "A")!
		await store.setScope(.favourites)
		let b = store.saveCurrentView(named: "B")!
		let removed = store.removeSavedView(a.id)
		#expect(removed?.view.name == "A")
		#expect(store.savedViews.views.map(\.id) == [b.id])
		store.restoreSavedView(removed!.view, at: removed!.index)
		#expect(store.savedViews.views.map(\.id) == [a.id, b.id])
		// Removing the view you are on drops you to its filters.
		_ = store.removeSavedView(b.id)
		#expect(store.scope == .favourites)
	}

	@Test("a saved view counts the objects that match it")
	func savedViewMatching() {
		let view = SavedView(name: "Mine", scope: .favourites, statusFilter: "todo", search: "migr")
		var o = WorkObject(id: "a", type: "task", title: "Write migration", status: "todo", isStarred: true)
		#expect(view.matches(o, needsYou: false))
		o.isStarred = false
		#expect(!view.matches(o, needsYou: false))
		let needs = SavedView(name: "Asks", scope: .needsYou)
		#expect(needs.matches(o, needsYou: true))
		#expect(!needs.matches(o, needsYou: false))
	}
}

@MainActor
@Suite("ObjectsStore: swipe actions with Undo")
struct ObjectsStoreSwipeTests {
	@Test("Done moves to the type's finished status and the undo puts it back")
	func markDone() async {
		let (store, remote) = makeStore()
		await store.load()
		let task = store.objects.first { $0.id == "t2" }!
		#expect(store.doneTarget(for: task) == "validated")
		let undo = await store.markDone("t2")
		#expect(store.objects.first { $0.id == "t2" }?.status == "validated")
		#expect(store.inventory.first { $0.id == "t2" }?.status == "validated")
		#expect(remote.updateKeys.count == 1)
		await store.undo(try! #require(undo))
		#expect(store.objects.first { $0.id == "t2" }?.status == "todo")
	}

	@Test("archiving one object uses its type's archive status")
	func archiveOne() async {
		let (store, _) = makeStore()
		await store.load()
		let undo = await store.archive("b1")
		#expect(store.objects.first { $0.id == "b1" }?.status == "archived")
		#expect(undo?.changes.first?.from == "active")
		#expect(await store.archive("b1") == nil)
	}

	@Test("a held delete is not sent until the window closes, and Undo cancels it")
	func heldDelete() async throws {
		let (store, remote) = makeStore()
		await store.load()
		await store.delete("t2", holdFor: .seconds(5))
		#expect(!store.objects.contains { $0.id == "t2" })
		#expect(!store.inventory.contains { $0.id == "t2" })
		#expect(remote.objects.contains { $0.id == "t2" })
		#expect(store.undoDelete("t2"))
		#expect(store.objects.map(\.id) == Fixtures.objects.map(\.id))
		#expect(store.inventory.contains { $0.id == "t2" })

		await store.delete("t2", holdFor: .milliseconds(20))
		try await waitUntil { !remote.objects.contains { $0.id == "t2" } }
		#expect(!store.undoDelete("t2"))
	}

	@Test("a refused held delete puts the row back")
	func heldDeleteFails() async throws {
		let (store, remote) = makeStore()
		await store.load()
		remote.fail("delete")
		await store.delete("t2", holdFor: .milliseconds(20))
		try await waitUntil { store.objects.contains { $0.id == "t2" } }
		#expect(store.actionError != nil)
	}
}

@Suite("Object type catalogue")
struct ObjectTypeCatalogTests {
	@Test("types sort into the prototype order, then alphabetically by label")
	func order() {
		let sorted = ObjectTypeCatalog.sorted(["zebra", "task", "account", "meeting", "apple", "bet"]) {
			$0 == "zebra" ? "Zebra" : nil
		}
		#expect(sorted == ["bet", "task", "account", "meeting", "apple", "zebra"])
		#expect(ObjectTypeCatalog.pluralLabel(for: "person") == "People")
		#expect(ObjectTypeCatalog.pluralLabel(for: "account") == "Companies")
		#expect(ObjectTypeCatalog.pluralLabel(for: "knowledge") == "Knowledge")
		#expect(ObjectTypeCatalog.pluralLabel(for: "release_note", displayName: "Release note") == "Release notes")
	}

	@Test("the scope titles read as the handoff says")
	func titles() {
		#expect(ObjectsScope.all.title(schema: .fallback) == "Objects")
		#expect(ObjectsScope.needsYou.title(schema: .fallback) == "Needs you")
		#expect(ObjectsScope.type("task").title(schema: .fallback) == "Tasks")
		#expect(ObjectsScope.saved("x").title(schema: .fallback) { _ in "Doing now" } == "Doing now")
		#expect(ObjectsScope.saved("x").title(schema: .fallback) == "Saved view")
	}

	@Test("display options saved before a field existed still decode")
	func displayOptionsDecode() throws {
		let data = Data(#"{"layout":"board","sort":"name"}"#.utf8)
		let options = try JSONDecoder().decode(ObjectsDisplay.self, from: data)
		#expect(options.layout == .board)
		#expect(options.sort == .name)
		#expect(options.groupBy == .status)
		#expect(options.shown == Set(ObjectsProperty.allCases))
		var round = options
		round.toggleCollapsed("x")
		let again = try JSONDecoder().decode(ObjectsDisplay.self, from: JSONEncoder().encode(round))
		#expect(again == round)
		#expect(round.isCustomised)
		#expect(!ObjectsDisplay().isCustomised)
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
