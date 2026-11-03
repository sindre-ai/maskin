import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

/// A throwaway defaults suite so tab memory never leaks between tests or into the real app.
private func freshDefaults() -> UserDefaults {
	let name = "ObjectDetailStoreTests.\(UUID().uuidString)"
	let defaults = UserDefaults(suiteName: name)!
	defaults.removePersistentDomain(forName: name)
	return defaults
}

@MainActor
private func makeStore(
	objectId: String = "t1", preload: Bool = false, defaults: UserDefaults = freshDefaults()
) -> (ObjectDetailStore, FakeObjectsRemote) {
	let remote = FakeObjectsRemote(objects: Fixtures.objects)
	let object = Fixtures.objects.first { $0.id == objectId }!
	remote.setGraph(Fixtures.graph(for: object))
	let directory = ObjectsDirectory(remote: remote, actors: Fixtures.actors)
	let store = ObjectDetailStore(
		objectId: objectId, remote: remote, directory: directory, currentActorId: "me",
		preload: preload ? object : nil, defaults: defaults)
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

	@Test("tagged actors ride the comment, and a retry tags the same people")
	func commentMentions() async throws {
		let (store, remote) = makeStore()
		await store.load()
		remote.fail("comment")
		await store.postComment("Look @Forge", mentions: ["a1"])
		remote.heal()
		let failed = try #require(store.timeline.last)
		await store.retryComment(failed.id)
		#expect(remote.commentMentions == [["a1"], ["a1"]])
	}

	@Test("linked objects ride as metadata.refs and keep their title on the posted comment")
	func commentRefs() async throws {
		let (store, remote) = makeStore()
		await store.load()
		let ref = CommentReference(id: "t2", title: "Write migration for devices", type: "task")
		await store.postComment("See this", refs: [ref])
		#expect(remote.commentRefs == [["t2"]])
		let last = try #require(store.timeline.last)
		#expect(store.references(for: last) == [ref])
	}

	@Test("attached files ride as attachment_file_ids and show their name on the posted comment")
	func commentAttachments() async throws {
		let (store, remote) = makeStore()
		await store.load()
		let file = ChatAttachmentRef(fileID: "f1", name: "spec.pdf", mimeType: "application/pdf", sizeBytes: 1200)
		await store.postComment("Spec attached", attachments: [file])
		#expect(remote.commentFiles == [["f1"]])
		let last = try #require(store.timeline.last)
		#expect(store.attachments(for: last).map(\.name) == ["spec.pdf"])
	}

	@Test("the / picker finds objects by title and never offers the open one")
	func searchObjects() async throws {
		let (store, _) = makeStore()
		await store.load()
		let all = await store.searchObjects("")
		#expect(!all.contains { $0.id == store.objectId })
		#expect(await store.searchObjects("zzzz-no-match").isEmpty)
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

	@Test("the last tab is remembered per object")
	func tabMemory() async {
		let defaults = freshDefaults()
		let (first, _) = makeStore(defaults: defaults)
		#expect(first.selectedTab == .overview)
		first.selectedTab = .activity
		let (again, _) = makeStore(defaults: defaults)
		#expect(again.selectedTab == .activity)
		let (other, _) = makeStore(objectId: "t2", defaults: defaults)
		#expect(other.selectedTab == .overview)
	}

	@Test("Latest is the newest event by date, whatever order the server sent them in")
	func latest() async {
		let (store, remote) = makeStore()
		var graph = Fixtures.graph(for: Fixtures.objects[0])
		// Newer than everything else but with a lower id and listed first.
		graph.events.insert(
			ObjectEvent(id: 0, actorId: "forge", action: "session_started", createdAt: Fixtures.date(1), summary: "started working"),
			at: 0)
		remote.setGraph(graph)
		await store.load()
		#expect(store.latest?.eventId == 0)
		#expect(store.latest.map(ActivityGrouping.summary(of:)) == "started working")
	}

	@Test("a stored reply carries its parent, and a reply posted here keeps it after sending")
	func threading() async throws {
		let (store, remote) = makeStore()
		var graph = Fixtures.graph(for: Fixtures.objects[0])
		graph.events.append(
			ObjectEvent(
				id: 5, actorId: "sigrid", action: "commented",
				data: .object(["content": .string("Agreed"), "parentEventId": .number(3)]), createdAt: Fixtures.date(8)))
		remote.setGraph(graph)
		await store.load()
		#expect(store.timeline.first { $0.eventId == 5 }?.parentEventId == 3)
		await store.postComment("Replying", parentEventId: 3)
		let sent = try #require(store.timeline.last)
		#expect(sent.delivery == .sent)
		#expect(sent.parentEventId == 3)
		// Fixture dates sit in the future, so only membership is asserted here; order is covered
		// by ActivityGroupingTests.
		let days = ActivityGrouping.days(store.timeline)
		let root = days.flatMap(\.entries).first { $0.item.eventId == 3 }
		let kinds = root?.replies.map(\.item.kind) ?? []
		#expect(kinds.count == 2)
		#expect(kinds.contains(.comment("Agreed")) && kinds.contains(.comment("Replying")))
	}

	@Test("a link without a title resolves it from the object; Untitled only when nothing resolves")
	func linkTitles() async throws {
		let (store, remote) = makeStore()
		var graph = Fixtures.graph(for: Fixtures.objects[0])
		graph.links.append(
			ObjectLink(id: "r3", relation: "relates_to", isOutgoing: true, otherId: "i1", otherType: "insight", otherTitle: "Untitled"))
		graph.links.append(
			ObjectLink(id: "r4", relation: "relates_to", isOutgoing: true, otherId: "ghost", otherType: "task", otherTitle: "Untitled"))
		remote.setGraph(graph)
		remote.setGraph(Fixtures.graph(for: Fixtures.objects[3]))  // i1: "Users want push notifications"
		await store.load()
		let insight = try #require(store.links.first { $0.id == "r3" })
		try await waitUntil { store.title(for: insight) == "Users want push notifications" }
		let ghost = try #require(store.links.first { $0.id == "r4" })
		#expect(store.title(for: ghost) == "Untitled")
		#expect(store.title(for: store.links[0]) == "Write migration for devices")
	}

	@Test("related groups put the flow first and sentence-case the phrase")
	func relatedGroups() async {
		let (store, remote) = makeStore()
		var graph = Fixtures.graph(for: Fixtures.objects[0])
		graph.links.append(
			ObjectLink(id: "r5", relation: "relates_to", isOutgoing: false, otherId: "l1", otherType: "loop", otherTitle: "Mobile launch"))
		remote.setGraph(graph)
		await store.load()
		#expect(store.relatedGroups.map(\.label) == ["In flow", "Blocking", "Belongs to"])
	}

	// Each property gets a fresh store: the fake's `update` answers from the graph it was seeded
	// with, not from the last write, so chained writes would read back stale fields.

	@Test("driver persists through a PATCH and rolls back when refused")
	func driver() async {
		let (store, remote) = makeStore(preload: true)
		await store.load()
		await store.setDriver("sigrid")
		#expect(store.object?.driverId == "sigrid")
		#expect(store.ownerName == "Sigrid Larsen")
		#expect(remote.updateKeys.count == 1)
		await store.setDriver("sigrid")
		#expect(remote.updateKeys.count == 1)

		remote.fail("update")
		await store.setDriver("me")
		#expect(store.object?.driverId == "sigrid")
		#expect(store.actionError == "boom")
	}

	@Test("priority is one metadata key, cleared with an empty value, rolled back when refused")
	func priority() async {
		let (store, remote) = makeStore(preload: true)
		await store.load()
		await store.setPriority("high")
		#expect(store.priority == "high")
		#expect(remote.updateKeys.count == 1)

		remote.fail("update")
		await store.setPriority("low")
		#expect(store.priority == "high")
		#expect(store.actionError == "boom")
		remote.heal()

		let (fresh, _) = makeStore(preload: true)
		await fresh.load()
		#expect(fresh.priority == nil)
		await fresh.setPriority(nil)
		#expect(fresh.priority == nil)
	}

	@Test("the due date is stored as yyyy-MM-dd and read back as a date")
	func due() async {
		let (store, remote) = makeStore(preload: true)
		await store.load()
		#expect(store.dueDate == nil)
		await store.setDueDate(Date(timeIntervalSince1970: 1_791_374_400))
		#expect(store.object?.metadata["due"] == "2026-10-07")
		#expect(store.dueDate != nil)
		#expect(remote.updateKeys.count == 1)
		#expect(ObjectDetailStore.parseDate("2026-10-07T12:00:00Z") != nil)
		#expect(ObjectDetailStore.parseDate("next week") == nil)
	}

	@Test("linking an object shows it at once, stores the edge, never links to itself, and undoes a refusal")
	func link() async {
		let (store, remote) = makeStore()
		await store.load()
		let ref = CommentReference(id: "i1", title: "Users want push notifications", type: "insight")
		await store.linkObject(ref)
		await store.linkObject(ref)
		await store.linkObject(CommentReference(id: "t1", title: "Me", type: "task"))
		let linked = store.links.filter { $0.otherId == "i1" }
		#expect(linked.count == 1)
		#expect(linked.first?.id.hasPrefix("rel-") == true)
		#expect(!store.links.contains { $0.otherId == "t1" })
		#expect(store.relatedGroups.map(\.label).contains("Relates to"))

		remote.fail("relationship")
		await store.linkObject(CommentReference(id: "t3", title: "Design empty states", type: "task"))
		#expect(!store.links.contains { $0.otherId == "t3" })
		#expect(store.actionError == "boom")
	}

	@Test("archive is offered only when the type has an archived status")
	func archive() async {
		let (task, _) = makeStore()
		await task.load()
		#expect(!task.canArchive)
		let (bet, _) = makeStore(objectId: "b1")
		await bet.load()
		#expect(bet.canArchive)
		await bet.archive()
		#expect(bet.object?.status == "archived")
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
