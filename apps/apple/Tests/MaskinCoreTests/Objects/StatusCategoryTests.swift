import Foundation
import Testing

@testable import MaskinCore

@Suite("StatusCategory")
struct StatusCategoryTests {
	@Test("every default workspace status has the documented category", arguments: [
		("backlog", StatusCategory.backlog), ("todo", .backlog), ("new", .backlog), ("signal", .backlog),
		("define", .backlog), ("paused", .backlog), ("parked", .backlog),
		("in_review", .needsYou), ("waiting_for_input", .needsYou), ("decide_pricing", .needsYou),
		("in_progress", .active), ("active", .active), ("live", .active), ("processing", .active),
		("clustered", .active),
		("done", .done), ("validated", .done), ("succeeded", .done), ("scored", .done),
		("discarded", .cancelled), ("archived", .cancelled), ("failed", .cancelled),
	])
	func table(status: String, expected: StatusCategory) {
		#expect(StatusCategory.of(status) == expected)
	}

	@Test("an unknown key is backlog, never urgent")
	func unknown() {
		#expect(StatusCategory.of("my_custom_status") == .backlog)
		#expect(StatusCategory.of("IN_PROGRESS") == .active)
	}

	@Test("approve moves to the next status of the next category, after the current one")
	func approve() {
		let bet = ObjectsSchema.fallback.statuses(for: "bet")
		#expect(StatusFlow.approveTarget(from: "active", in: bet) == "succeeded")
		let task = ObjectsSchema.fallback.statuses(for: "task")
		#expect(StatusFlow.approveTarget(from: "in_progress", in: task) == "validated")
		// Needs you → Active, but task's only Active status sits before in_review: hidden.
		#expect(StatusFlow.approveTarget(from: "in_review", in: task) == nil)
		#expect(StatusFlow.approveTarget(from: "todo", in: task) == nil)
		#expect(StatusFlow.approveTarget(from: "done", in: task) == nil)
		#expect(StatusFlow.approveTarget(from: "in_progress", in: ["in_progress"]) == nil)
		#expect(StatusFlow.approveTarget(from: "unlisted", in: task) == nil)
	}

	@Test("archive prefers archived, then discarded, then any cancelled status")
	func archive() {
		let schema = ObjectsSchema.fallback
		#expect(StatusFlow.archiveTarget(in: schema.statuses(for: "bet")) == "archived")
		#expect(StatusFlow.archiveTarget(in: schema.statuses(for: "task")) == "discarded")
		#expect(StatusFlow.archiveTarget(in: ["open", "declined"]) == "declined")
		#expect(StatusFlow.archiveTarget(in: ["open", "closed"]) == nil)
	}

	@Test("tone follows the category")
	func tone() {
		func tone(_ status: String) -> ObjectsStatusTone {
			ObjectsStatusTone.of(WorkObject(id: "x", type: "task", status: status))
		}
		#expect(tone("in_progress") == .patina)
		#expect(tone("in_review") == .patina)
		#expect(tone("done") == .ink)
		#expect(tone("failed") == .quiet)
		#expect(tone("todo") == .neutral)
	}
}

@MainActor
@Suite("Selection actions on ObjectsStore")
struct ObjectsSelectionActionTests {
	private func make(_ objects: [WorkObject] = Fixtures.objects) -> (ObjectsStore, FakeObjectsRemote) {
		let remote = FakeObjectsRemote(objects: objects)
		let directory = ObjectsDirectory(remote: remote, actors: Fixtures.actors)
		return (ObjectsStore(remote: remote, directory: directory), remote)
	}

	@Test("archive moves each to its type's archive status, with an undo that puts them back")
	func archiveAndUndo() async {
		let (store, remote) = make()
		await store.load()
		#expect(store.canArchive(["t1", "b1"]))
		let outcome = await store.archive(["t1", "b1"])
		#expect(outcome.result.succeeded == 2)
		#expect(store.objects.first { $0.id == "t1" }?.status == "discarded")
		#expect(store.objects.first { $0.id == "b1" }?.status == "archived")
		#expect(outcome.undo.changes.map(\.from) == ["in_progress", "active"])
		#expect(Set(remote.updateKeys).count == remote.updateKeys.count, "one Idempotency-Key per write")
		await store.undo(outcome.undo)
		#expect(store.objects.first { $0.id == "t1" }?.status == "in_progress")
		#expect(store.objects.first { $0.id == "b1" }?.status == "active")
	}

	@Test("undo reaches an object the list no longer holds")
	func undoAfterRefreshDropped() async {
		let (store, remote) = make()
		await store.load()
		let outcome = await store.archive(["b1"])
		store.remove("b1")
		let before = remote.updateKeys.count
		await store.undo(outcome.undo)
		#expect(remote.updateKeys.count == before + 1)
	}

	@Test("a failed write rolls the row back and is not offered for undo")
	func archiveFailure() async {
		let (store, remote) = make()
		await store.load()
		remote.fail("update")
		let outcome = await store.archive(["t1"])
		#expect(outcome.result.failed == 1)
		#expect(outcome.undo.isEmpty)
		#expect(store.objects.first { $0.id == "t1" }?.status == "in_progress")
		#expect(store.actionError != nil)
	}

	@Test("set status offers only what every picked type allows")
	func commonStatuses() async {
		let (store, _) = make()
		await store.load()
		#expect(store.commonStatuses(for: ["t1", "t2"]) == ObjectsSchema.fallback.statuses(for: "task"))
		// Tasks and bets share no status key in the default workspace.
		#expect(store.commonStatuses(for: ["t1", "b1"]).isEmpty)
	}

	@Test("assign sets the driver optimistically and rolls back on failure")
	func assign() async {
		let (store, remote) = make()
		await store.load()
		let ok = await store.assign(["t2"], to: "forge")
		#expect(ok.succeeded == 1)
		#expect(store.objects.first { $0.id == "t2" }?.driverId == "forge")
		remote.fail("update")
		let bad = await store.assign(["t2"], to: "sigrid")
		#expect(bad.failed == 1)
		#expect(store.objects.first { $0.id == "t2" }?.driverId == "forge")
	}

	@Test("approve moves an active object on and can be undone")
	func approve() async {
		let (store, _) = make()
		await store.load()
		let task = store.objects.first { $0.id == "t1" }!
		#expect(store.approveTarget(for: task) == "validated")
		let undo = await store.approve("t1")
		#expect(store.objects.first { $0.id == "t1" }?.status == "validated")
		await store.undo(try! #require(undo))
		#expect(store.objects.first { $0.id == "t1" }?.status == "in_progress")
		#expect(await store.approve("t2") == nil)
	}
}

@MainActor
@Suite("Board moves")
struct ObjectsBoardMoveTests {
	@Test("a drop moves the card, adjusts both totals and returns the way back")
	func moving() async {
		let remote = FakeObjectsRemote(objects: Fixtures.objects)
		let store = ObjectsBoardStore(remote: remote)
		await store.load(type: "task", sort: .updated)
		let change = await store.move("t2", toColumn: "in_progress")
		#expect(change == StatusChange(id: "t2", from: "todo", to: "in_progress"))
		#expect(store.columns.first { $0.value == "todo" }?.total == 0)
		let target = try! #require(store.columns.first { $0.value == "in_progress" })
		#expect(target.total == 3)
		#expect(target.objects.contains { $0.id == "t2" })
		_ = await store.move("t2", toColumn: "todo")
		#expect(store.columns.first { $0.value == "todo" }?.total == 1)
	}

	@Test("a failed write puts the card back")
	func failure() async {
		let remote = FakeObjectsRemote(objects: Fixtures.objects)
		let store = ObjectsBoardStore(remote: remote)
		await store.load(type: "task", sort: .updated)
		remote.fail("update")
		#expect(await store.move("t2", toColumn: "done") == nil)
		#expect(store.columns.first { $0.value == "todo" }?.objects.map(\.id) == ["t2"])
		#expect(store.moveError != nil)
	}

	@Test("same column and unknown targets do nothing")
	func noops() {
		let columns = [
			ObjectsBoardColumn(id: "a", value: "todo", total: 1, objects: [WorkObject(id: "x", type: "task", status: "todo")]),
			ObjectsBoardColumn(id: "b", value: "done", total: 0, objects: []),
		]
		#expect(ObjectsBoardMoves.moving("x", to: "todo", in: columns) == nil)
		#expect(ObjectsBoardMoves.moving("x", to: "nowhere", in: columns) == nil)
		#expect(ObjectsBoardMoves.moving("nope", to: "done", in: columns) == nil)
		#expect(ObjectsBoardMoves.moving("x", to: "done", in: columns)?.columns[1].total == 1)
	}
}
