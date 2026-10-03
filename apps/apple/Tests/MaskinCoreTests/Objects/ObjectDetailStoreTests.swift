import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

@MainActor
private func makeStore(
	objectId: String = "t1", preload: Bool = false
) -> (ObjectDetailStore, FakeObjectsRemote) {
	let remote = FakeObjectsRemote(objects: Fixtures.objects)
	let object = Fixtures.objects.first { $0.id == objectId }!
	remote.setGraph(Fixtures.graph(for: object))
	let directory = ObjectsDirectory(remote: remote, actors: Fixtures.actors)
	let store = ObjectDetailStore(
		objectId: objectId, remote: remote, directory: directory, currentActorId: "me",
		preload: preload ? object : nil)
	return (store, remote)
}

@MainActor
@Suite("ObjectDetailStore")
struct ObjectDetailStoreTests {
	@Test("loads the object, its links and a chronological timeline with attribution")
	func load() async {
		let (store, _) = makeStore()
		await store.load()
		#expect(store.phase == .loaded)
		#expect(store.object?.title == "Wire up SSE reconnect")
		#expect(store.ownerName == "Forge")
		#expect(store.links.map(\.phrase) == ["blocks", "part of"])
		#expect(store.timeline.map(\.eventId) == [1, 2, 3, 4])
		let comment = store.timeline[2]
		#expect(comment.kind == .comment("Reconnect is flaky on cellular. I'm adding **backoff** with jitter."))
		#expect(store.authorName(for: comment) == "Forge")
		#expect(store.isAgent(comment))
		#expect(store.authorName(for: store.timeline[3]) == "You")
		#expect(store.timeline[1].kind == .activity("moved status from todo to in progress"))
	}

	@Test("an unresolvable actor reads as Someone, never an id")
	func unknownActor() async {
		let (store, _) = makeStore()
		await store.load()
		let item = TimelineItem(id: "x", kind: .comment("hi"), actorId: "0b9c-uuid", date: nil, delivery: .sent, eventId: 77)
		#expect(store.authorName(for: item) == "Someone")
	}

	@Test("a deleted object lands in the gone phase")
	func gone() async {
		let remote = FakeObjectsRemote()
		let store = ObjectDetailStore(
			objectId: "nope", remote: remote, directory: ObjectsDirectory(remote: remote, actors: []),
			currentActorId: nil)
		await store.load()
		#expect(store.phase == .gone)
	}

	@Test("comment appears immediately as sending, then becomes the stored event")
	func commentOptimistic() async throws {
		let (store, remote) = makeStore()
		await store.load()
		let post = Task { await store.postComment("  On it  ") }
		await post.value
		let last = try #require(store.timeline.last)
		#expect(last.kind == .comment("On it"))
		#expect(last.delivery == .sent)
		#expect(last.eventId != nil)
		#expect(store.authorName(for: last) == "You")
		#expect(remote.commentKeys.count == 1)
	}

	@Test("a failed comment stays, and retry reuses the same idempotency key")
	func commentRetry() async throws {
		let (store, remote) = makeStore()
		await store.load()
		remote.fail("comment")
		await store.postComment("Please look")
		let failed = try #require(store.timeline.last)
		#expect(failed.delivery == .failed)
		#expect(failed.isLocal)

		remote.heal()
		await store.retryComment(failed.id)
		let sent = try #require(store.timeline.last)
		#expect(sent.delivery == .sent)
		#expect(store.timeline.filter { $0.kind == .comment("Please look") }.count == 1)
		#expect(remote.commentKeys.count == 2)
		#expect(Set(remote.commentKeys).count == 1)
	}

	@Test("discarding an unsent comment removes it; empty text posts nothing")
	func discard() async throws {
		let (store, remote) = makeStore()
		await store.load()
		await store.postComment("   ")
		#expect(remote.commentKeys.isEmpty)
		remote.fail("comment")
		await store.postComment("nope")
		store.discardComment(try #require(store.timeline.last).id)
		#expect(!store.timeline.contains { $0.kind == .comment("nope") })
	}

	@Test("a refresh keeps comments the server doesn't know yet")
	func refreshKeepsPending() async throws {
		let (store, remote) = makeStore()
		await store.load()
		remote.fail("comment")
		await store.postComment("Still here")
		remote.heal()
		await store.refresh()
		#expect(store.timeline.last?.kind == .comment("Still here"))
		#expect(store.timeline.count == 5)
	}

	@Test("status edit is optimistic, persists, and carries one key per write")
	func editStatus() async {
		let (store, remote) = makeStore(preload: true)
		await store.load()
		var changed: [WorkObject] = []
		store.onObjectChanged = { changed.append($0) }
		await store.setStatus("in_review")
		#expect(store.object?.status == "in_review")
		#expect(changed.first?.status == "in_review")
		#expect(remote.updateKeys.count == 1)
		#expect(store.actionError == nil)
	}

	@Test("a refused edit puts back exactly what it overwrote")
	func editRollback() async {
		let (store, remote) = makeStore(preload: true)
		await store.load()
		remote.fail("update")
		await store.edit(ObjectPatch(title: "New title", status: "done"))
		#expect(store.object?.title == "Wire up SSE reconnect")
		#expect(store.object?.status == "in_progress")
		#expect(store.actionError == "boom")
	}

	@Test("star toggles optimistically and rolls back on failure")
	func star() async {
		let (store, remote) = makeStore()
		await store.load()
		await store.toggleStar()
		#expect(store.object?.isStarred == true)
		remote.fail("star")
		await store.toggleStar()
		#expect(store.object?.isStarred == true)
		#expect(store.actionError != nil)
	}

	@Test("delete reports success to the list, failure as an error")
	func delete() async {
		let (store, remote) = makeStore()
		await store.load()
		var removed: String?
		store.onObjectDeleted = { removed = $0 }
		remote.fail("delete")
		await store.delete()
		#expect(!store.didDelete)
		#expect(store.actionError != nil)
		remote.heal()
		await store.delete()
		#expect(store.didDelete)
		#expect(removed == "t1")
	}

	@Test("events on this object refetch it; other objects and reconnects behave")
	func liveRefresh() async throws {
		let (store, remote) = makeStore()
		await store.load()
		let (stream, continuation) = AsyncStream<HubSignal>.makeStream()
		let task = Task { await store.observe(stream) }

		var updated = Fixtures.graph(for: Fixtures.objects[0])
		updated.object.status = "done"
		updated.events.append(
			ObjectEvent(id: 5, actorId: "forge", action: "commented", data: .object(["content": .string("Done!")]), createdAt: Fixtures.date(0)))
		remote.setGraph(updated)

		continuation.yield(.event(WorkspaceEvent(id: "a", action: "updated", entityType: .object, entityId: "someone-else")))
		continuation.yield(.event(WorkspaceEvent(id: "b", action: "commented", entityType: .object, entityId: "t1")))
		try await waitUntil { store.object?.status == "done" }
		#expect(store.timeline.last?.kind == .comment("Done!"))

		continuation.yield(.event(WorkspaceEvent(id: "c", action: "deleted", entityType: .object, entityId: "t1")))
		try await waitUntil { store.phase == .gone }
		continuation.finish()
		await task.value
	}

	@Test("link phrases read from the viewed object's side")
	func phrases() {
		func link(_ relation: String, out: Bool) -> ObjectLink {
			ObjectLink(id: "x", relation: relation, isOutgoing: out, otherId: "o", otherType: "task", otherTitle: "T")
		}
		#expect(link("blocks", out: true).phrase == "blocks")
		#expect(link("blocks", out: false).phrase == "blocked by")
		#expect(link("relates_to", out: false).phrase == "relates to")
		#expect(link("breaks_into", out: true).phrase == "breaks into")
	}

	@Test("workspace settings become a schema with core types first")
	func schemaParsing() {
		let settings: JSONValue = .object([
			"statuses": .object([
				"task": .array([.string("open"), .string("closed")]),
				"loop": .array([.string("on")]),
				"deal": .array([.string("won")]),
			]),
			"display_names": .object(["deal": .string("Deal")]),
		])
		let schema = APIObjectsRemote.schema(from: settings)
		#expect(schema.types == ["task", "deal"])
		#expect(schema.statuses(for: "task") == ["open", "closed"])
		#expect(schema.displayName(for: "deal") == "Deal")
		#expect(schema.displayName(for: "task") == "Task")
		#expect(APIObjectsRemote.schema(from: .object([:])) == .fallback)
	}
}
