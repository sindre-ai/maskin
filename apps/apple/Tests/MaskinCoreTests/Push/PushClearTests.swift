import Foundation
import Testing

@testable import MaskinCore

@Suite("Server clear push contract")
struct ServerClearPushContractTests {
	/// Exactly what the server's clear push (apps/dev/src/services/apns.ts) emits. If the server
	/// shape changes, this and its twin in apns.test.ts must change together.
	private static let serverPayload = """
		{"aps":{"content-available":1,"badge":2},
		"clear":{"notification_ids":["n-1","n-2"],"collapse_key":"rollup:o-1","thread_id":"object:o-1"}}
		"""

	private func parse(_ json: String) throws -> PushClearPayload? {
		let object = try #require(
			try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
		return PushClearPayload(userInfo: object)
	}

	@Test("reads the ids, the collapse key, the thread and the badge")
	func readsServerPayload() throws {
		let clear = try #require(try parse(Self.serverPayload))
		#expect(clear.notificationIds == ["n-1", "n-2"])
		#expect(clear.collapseKey == "rollup:o-1")
		#expect(clear.threadId == "object:o-1")
		#expect(clear.badge == 2)
	}

	@Test("a push without a clear object is not a clear")
	func notAClear() throws {
		#expect(try parse(#"{"aps":{"alert":{"title":"x"}},"notification_id":"n-1"}"#) == nil)
	}

	@Test("ignores junk: non-string ids, empty keys, a negative badge")
	func junk() throws {
		let clear = try #require(
			try parse(
				#"{"aps":{"badge":-1},"clear":{"notification_ids":["n-1",5,""],"collapse_key":"","thread_id":7}}"#
			))
		#expect(clear.notificationIds == ["n-1"])
		#expect(clear.collapseKey == nil && clear.threadId == nil && clear.badge == nil)
	}

	private let delivered = [
		DeliveredPush(identifier: "n-1", notificationId: "n-1", threadId: "object:o-1", workspaceId: "ws-1"),
		DeliveredPush(identifier: "rollup:o-2", notificationId: "n-7", threadId: "rollup:o-2", workspaceId: "ws-1"),
		DeliveredPush(identifier: "n-3", notificationId: "n-3", threadId: "object:o-3", workspaceId: "ws-1"),
		DeliveredPush(identifier: "n-4", notificationId: "n-4", threadId: "chat:c-9", workspaceId: "ws-1"),
	]

	@Test("clears by notification id")
	func byId() {
		let clear = PushClearPayload(notificationIds: ["n-1"])
		#expect(clear.identifiers(in: delivered) == ["n-1"])
	}

	@Test("clears a rollup by its collapse key and a chat by its thread")
	func byKeyAndThread() {
		let clear = PushClearPayload(collapseKey: "rollup:o-2", threadId: "chat:c-9")
		#expect(clear.identifiers(in: delivered) == ["rollup:o-2", "n-4"])
	}

	@Test("clears nothing it was not asked about")
	func nothingElse() {
		#expect(PushClearPayload(notificationIds: ["other"]).identifiers(in: delivered).isEmpty)
		#expect(PushClearPayload().identifiers(in: delivered).isEmpty)
	}
}

@Suite("Delivered sweep")
struct DeliveredSweepTests {
	private let delivered = [
		DeliveredPush(identifier: "n-1", notificationId: "n-1", threadId: "object:o-1", workspaceId: "ws-1"),
		DeliveredPush(identifier: "n-2", notificationId: "n-2", threadId: "object:o-2", workspaceId: "ws-1"),
		DeliveredPush(identifier: "n-3", notificationId: "n-3", threadId: "workspace:ws-1", workspaceId: "ws-1"),
		DeliveredPush(identifier: "n-4", notificationId: "n-4", threadId: "chat:c-9", workspaceId: "ws-1"),
		DeliveredPush(identifier: "rollup:o-5", notificationId: "n-5", threadId: "rollup:o-5", workspaceId: "ws-1"),
		DeliveredPush(identifier: "n-6", notificationId: "n-6", threadId: "object:o-6", workspaceId: "ws-2"),
		DeliveredPush(identifier: "n-7", notificationId: nil, threadId: "object:o-7", workspaceId: "ws-1"),
	]

	@Test("removes a delivered push whose notification is no longer pending")
	func removesHandled() {
		let stale = DeliveredSweep.staleIdentifiers(
			delivered: delivered, pendingIds: ["n-2"], workspaceId: "ws-1")
		#expect(stale == ["n-1", "n-3"])
	}

	@Test("never judges chats, rollups, other workspaces or pushes without an id")
	func leavesTheRest() {
		let stale = DeliveredSweep.staleIdentifiers(
			delivered: delivered, pendingIds: [], workspaceId: "ws-1")
		#expect(!stale.contains("n-4") && !stale.contains("rollup:o-5"))
		#expect(!stale.contains("n-6") && !stale.contains("n-7"))
	}

	@Test("compares ids ignoring case")
	func caseInsensitive() {
		let stale = DeliveredSweep.staleIdentifiers(
			delivered: [delivered[0]], pendingIds: ["N-1"], workspaceId: "WS-1")
		#expect(stale.isEmpty)
	}
}

@MainActor
@Suite("Delivered notification sync")
struct DeliveredNotificationSyncTests {
	private final class Center: DeliveredNotificationCenter, @unchecked Sendable {
		var pushes: [DeliveredPush]
		var removed: [String] = []
		init(_ pushes: [DeliveredPush]) { self.pushes = pushes }
		func delivered() async -> [DeliveredPush] { pushes }
		func remove(identifiers: [String]) async { removed += identifiers }
	}

	private struct Pending: PendingNotificationSource {
		var ids: Set<String>?
		func pendingNotificationIds(workspaceId: String) async -> Set<String>? { ids }
	}

	private final class Badge: @unchecked Sendable {
		var value: Int?
	}

	private static let pushes = [
		DeliveredPush(identifier: "n-1", notificationId: "n-1", threadId: "object:o-1", workspaceId: "ws-1"),
		DeliveredPush(identifier: "n-2", notificationId: "n-2", threadId: "object:o-2", workspaceId: "ws-1"),
		DeliveredPush(identifier: "n-4", notificationId: "n-4", threadId: "chat:c-9", workspaceId: "ws-1"),
	]

	private func makeSync(_ center: Center, pending: Set<String>?, badge: Badge, workspace: String? = "ws-1")
		-> DeliveredNotificationSync
	{
		DeliveredNotificationSync(
			center: center, pending: Pending(ids: pending), workspaceId: { workspace },
			setBadge: { badge.value = $0 })
	}

	@Test("a foreground removes handled pushes and sets the badge to the pending count")
	func reconcile() async {
		let center = Center(Self.pushes)
		let badge = Badge()
		await makeSync(center, pending: ["n-2", "x"], badge: badge).reconcile()
		#expect(center.removed == ["n-1"])
		#expect(badge.value == 2)
	}

	@Test("an unreadable pending list changes nothing")
	func unreadable() async {
		let center = Center(Self.pushes)
		let badge = Badge()
		await makeSync(center, pending: nil, badge: badge).reconcile()
		#expect(center.removed.isEmpty && badge.value == nil)
	}

	@Test("no workspace, no sync")
	func noWorkspace() async {
		let center = Center(Self.pushes)
		let badge = Badge()
		await makeSync(center, pending: [], badge: badge, workspace: nil).reconcile()
		#expect(center.removed.isEmpty && badge.value == nil)
	}

	@Test("answering a card drops that object's pushes, opening a chat drops that chat's")
	func inApp() async {
		let center = Center(Self.pushes)
		let sync = makeSync(center, pending: [], badge: Badge())
		await sync.cardHandled(objectId: "o-1")
		await sync.chatOpened(conversationId: "c-9")
		#expect(center.removed == ["n-1", "n-4"])
	}
}
