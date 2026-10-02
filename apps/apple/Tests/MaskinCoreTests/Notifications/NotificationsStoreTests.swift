import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

private let yes = AppNotification.Action(id: "a0", label: "Approve", response: .string("approve"), style: .primary)

@MainActor
private func makeStore(
	_ source: FakeNotificationsSource, me: String? = "me"
) -> NotificationsStore {
	NotificationsStore(source: source, currentActorId: { me })
}

@MainActor
@Suite("NotificationsStore")
struct NotificationsStoreTests {
	@Test("loads newest first and counts unread")
	func loads() async {
		let source = FakeNotificationsSource([
			makeNotification("old", at: 0), makeNotification("new", at: 100),
			makeNotification("read", status: .seen, at: 50),
		])
		let store = makeStore(source)
		#expect(store.phase == .idle)
		await store.reload()
		#expect(store.phase == .loaded)
		#expect(store.notifications.map(\.id) == ["new", "read", "old"])
		#expect(store.unreadCount == 2)
	}

	@Test("shows only notifications untargeted or aimed at me")
	func filtersByTarget() async {
		let source = FakeNotificationsSource([
			makeNotification("open", at: 3), makeNotification("mine", at: 2, target: "me"),
			makeNotification("theirs", at: 1, target: "someone-else"),
		])
		let store = makeStore(source)
		await store.reload()
		#expect(store.notifications.map(\.id) == ["open", "mine"])
	}

	@Test("resolves sender names once")
	func actorNames() async {
		let source = FakeNotificationsSource([makeNotification("a"), makeNotification("b")])
		let store = makeStore(source)
		await store.reload()
		await store.reload()
		#expect(store.actor(for: "agent-1")?.name == "Relay")
		#expect(await source.actorLookups == [["agent-1"]])
	}

	@Test("a failed first load is an error; a failed refresh keeps the list and flags offline")
	func failures() async {
		let source = FakeNotificationsSource([makeNotification("a")])
		await source.setFailList(true)
		let store = makeStore(source)
		await store.reload()
		#expect(store.phase == .failed("offline"))
		await source.setFailList(false)
		await store.reload()
		#expect(store.phase == .loaded)
		await source.setFailList(true)
		await store.reload()
		#expect(store.phase == .loaded)
		#expect(store.isOffline)
		#expect(store.notifications.count == 1)
	}

	@Test("mark read is optimistic and sends seen")
	func markRead() async {
		let source = FakeNotificationsSource([makeNotification("a")])
		let store = makeStore(source)
		await store.reload()
		await store.markRead("a")
		#expect(store.notifications[0].status == .seen)
		#expect(store.unreadCount == 0)
		let calls = await source.statusCalls
		#expect(calls.count == 1 && calls[0].0 == "a" && calls[0].1 == .seen)
		await store.markRead("a")  // already read: no second request
		#expect(await source.statusCalls.count == 1)
	}

	@Test("mark unread flips back to pending")
	func markUnread() async {
		let source = FakeNotificationsSource([makeNotification("a", status: .seen)])
		let store = makeStore(source)
		await store.reload()
		await store.markUnread("a")
		#expect(store.notifications[0].status == .pending)
		#expect(store.unreadCount == 1)
	}

	@Test("a refused mutation rolls back and reports")
	func rollback() async {
		let source = FakeNotificationsSource([makeNotification("a")])
		let store = makeStore(source)
		await store.reload()
		await source.setFailMutations(true)
		await store.markRead("a")
		#expect(store.notifications[0].status == .pending)
		#expect(store.actionError != nil)
		store.dismissError()
		#expect(store.actionError == nil)
	}

	@Test("delete removes the row and restores it if refused")
	func delete() async {
		let source = FakeNotificationsSource([makeNotification("a", at: 2), makeNotification("b", at: 1)])
		let store = makeStore(source)
		await store.reload()
		await store.delete("a")
		#expect(store.notifications.map(\.id) == ["b"])
		await source.setFailMutations(true)
		await store.delete("b")
		#expect(store.notifications.map(\.id) == ["b"])
		#expect(store.actionError != nil)
	}

	@Test("responding resolves the row and sends the response value")
	func respond() async {
		let source = FakeNotificationsSource([makeNotification("a", actions: [yes])])
		let store = makeStore(source)
		await store.reload()
		await store.respond(to: "a", with: .string("approve"))
		#expect(store.notifications[0].status == .resolved)
		#expect(store.notifications[0].response == .string("approve"))
		#expect(await source.responses.count == 1)
		await store.respond(to: "a", with: .string("approve"))  // already resolved: ignored
		#expect(await source.responses.count == 1)
	}

	@Test("a failed response restores the actionable state")
	func respondRollback() async {
		let source = FakeNotificationsSource([makeNotification("a", actions: [yes])])
		let store = makeStore(source)
		await store.reload()
		await source.setFailMutations(true)
		await store.respond(to: "a", with: .string("approve"))
		#expect(store.notifications[0].status == .pending)
		#expect(store.notifications[0].canRespond)
		#expect(store.actionError != nil)
	}

	@Test("notifications without actions can't be responded to")
	func respondGuard() async {
		let source = FakeNotificationsSource([makeNotification("a")])
		let store = makeStore(source)
		await store.reload()
		await store.respond(to: "a", with: .string("x"))
		#expect(await source.responses.isEmpty)
	}

	@Test("mark all read touches only unread rows")
	func markAll() async {
		let source = FakeNotificationsSource([
			makeNotification("a", at: 3), makeNotification("b", status: .seen, at: 2),
			makeNotification("c", at: 1),
		])
		let store = makeStore(source)
		await store.reload()
		await store.markAllRead()
		#expect(store.unreadCount == 0)
		#expect(await source.statusCalls.count == 2)
	}

	@Test("activating another workspace drops the old rows")
	func workspaceSwitch() async {
		let source = FakeNotificationsSource([makeNotification("a")])
		let store = makeStore(source)
		store.activate(workspaceId: "ws-1", events: nil)
		await store.reload()
		#expect(!store.isEmpty)
		store.activate(workspaceId: "ws-2", events: nil)
		#expect(store.isEmpty)
		#expect(store.phase == .idle)
	}

	/// Starts the store against a scripted event stream, waits for its initial load, then connects.
	private func liveStore(_ bodies: [String], holdOpen: Bool = true) async throws -> (NotificationsStore, FakeNotificationsSource, Int, EventHub) {
		let source = FakeNotificationsSource([makeNotification("a")])
		let store = makeStore(source)
		let script = Script(bodies)
		let client = SSEClient(
			open: { _ in
				let body = await script.next()
				return AsyncThrowingStream { c in
					if let body { for b in body.utf8 { c.yield(b) } }
					if body != nil && !holdOpen { c.finish() }
				}
			},
			backoff: SSEBackoff(initial: .milliseconds(1), max: .milliseconds(2)),
			silenceTimeout: .seconds(30))
		let hub = EventHub(client: client)
		store.start(events: hub)
		try await waitUntil { store.phase == .loaded }
		let baseline = await source.listCalls
		hub.connect(workspaceId: "w1")
		return (store, source, baseline, hub)
	}

	@Test("a notification event triggers a reload")
	func liveNotificationEvent() async throws {
		let (store, source, baseline, hub) = try await liveStore([frame(1, entity: "notification")])
		try await waitUntil { await source.listCalls > baseline }
		store.stop()
		hub.disconnect()
	}

	@Test("events about other entities don't reload")
	func liveOtherEvent() async throws {
		let (store, source, baseline, hub) = try await liveStore([frame(1, entity: "object"), frame(2, entity: "session")])
		try await Task.sleep(for: .milliseconds(300))
		#expect(await source.listCalls == baseline)
		store.stop()
		hub.disconnect()
	}

	@Test("a reconnect reloads")
	func liveReconnect() async throws {
		let (store, source, baseline, hub) = try await liveStore([frame(1, entity: "object")], holdOpen: false)
		try await waitUntil { await source.listCalls > baseline }
		store.stop()
		hub.disconnect()
	}

	@Test("newest-first ordering is stable for undated rows")
	func ordering() {
		let undated = AppNotification(id: "z", workspaceId: "w", kind: .alert, title: "t", sourceActorId: "x")
		let dated = makeNotification("a", at: 1)
		#expect(NotificationsStore.newestFirst([undated, dated]).map(\.id) == ["a", "z"])
	}
}

@MainActor
private func waitUntil(_ condition: @MainActor @escaping () async -> Bool) async throws {
	for _ in 0..<500 {
		if await condition() { return }
		try await Task.sleep(for: .milliseconds(20))
	}
	Issue.record("condition not met in time")
}

private func frame(_ id: Int, entity: String) -> String {
	let json =
		#"{"workspace_id":"w1","actor_id":"a","action":"updated","entity_type":"\#(entity)","entity_id":"e\#(id)","event_id":"\#(id)"}"#
	return "id: \(id)\nevent: updated\ndata: \(json)\n\n"
}

private actor Script {
	var bodies: [String]
	init(_ bodies: [String]) { self.bodies = bodies }
	func next() -> String? { bodies.isEmpty ? nil : bodies.removeFirst() }
}
