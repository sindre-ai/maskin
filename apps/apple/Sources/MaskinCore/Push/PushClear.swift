import Foundation

// The server contract (apps/dev/src/services/apns.ts, clear push): a background push
// (`apns-push-type: background`) that tells the phone to take handled notifications off the lock
// screen and Notification Center:
//
//     "aps": { "content-available": 1, "badge": 2 },
//     "clear": { "notification_ids": ["n-1", "n-2"], "collapse_key": "rollup:o-1"?, "thread_id": "object:o-1"? }
//
// iOS may delay or drop it (and never runs it after a force quit), so the app also reconciles on
// every foreground (`DeliveredNotificationSync`).

/// What a clear push asks for. Plain values, parsed defensively: anything malformed is ignored
/// rather than crashing a background wake-up.
public struct PushClearPayload: Sendable, Equatable {
	public var notificationIds: [String]
	public var collapseKey: String?
	public var threadId: String?
	/// `aps.badge`: the pending count the server computed. `nil` when the push carries none.
	public var badge: Int?

	public init(
		notificationIds: [String] = [], collapseKey: String? = nil, threadId: String? = nil,
		badge: Int? = nil
	) {
		self.notificationIds = notificationIds
		self.collapseKey = collapseKey
		self.threadId = threadId
		self.badge = badge
	}

	/// `nil` unless the payload has a root `clear` object.
	public init?(userInfo: [AnyHashable: Any]) {
		guard let clear = userInfo["clear"] as? [String: Any] else { return nil }
		let ids = (clear["notification_ids"] as? [Any] ?? []).compactMap { $0 as? String }
			.filter { !$0.isEmpty }
		let badge = ((userInfo["aps"] as? [String: Any])?["badge"] as? Int).flatMap { $0 >= 0 ? $0 : nil }
		self.init(
			notificationIds: ids, collapseKey: Self.text(clear["collapse_key"]),
			threadId: Self.text(clear["thread_id"]), badge: badge)
	}

	private static func text(_ value: Any?) -> String? {
		guard let string = value as? String, !string.isEmpty else { return nil }
		return string
	}

	/// The delivered notifications this push clears: named by id (the request identifier is the
	/// notification id, or the collapse key for a rollup), or sharing the collapse key or thread.
	public func identifiers(in delivered: [DeliveredPush]) -> [String] {
		delivered.filter(matches).map(\.identifier)
	}

	private func matches(_ push: DeliveredPush) -> Bool {
		if notificationIds.contains(push.identifier) { return true }
		if let id = push.notificationId, notificationIds.contains(id) { return true }
		if let key = collapseKey, push.identifier == key || push.threadId == key { return true }
		if let threadId, push.threadId == threadId { return true }
		return false
	}
}

/// A notification our server delivered that is still on this device, reduced to what the clear and
/// the foreground sweep need.
public struct DeliveredPush: Sendable, Equatable {
	/// The request identifier (the notification id, or the collapse key for a rollup).
	public var identifier: String
	/// `notification_id` from the payload.
	public var notificationId: String?
	/// `aps.thread-id`: `chat:<id>`, `object:<id>`, `workspace:<id>` or a rollup's collapse key.
	public var threadId: String?
	public var workspaceId: String?

	public init(
		identifier: String, notificationId: String? = nil, threadId: String? = nil,
		workspaceId: String? = nil
	) {
		self.identifier = identifier
		self.notificationId = notificationId
		self.threadId = threadId
		self.workspaceId = workspaceId
	}
}

/// Which delivered notifications are stale against the server's pending list.
public enum DeliveredSweep {
	/// Identifiers to remove: a push for this workspace whose notification is no longer pending.
	///
	/// Conservative on purpose, because a wrong removal loses something unread:
	/// - chat pushes are stored as seen, never pending, so they are never swept here (a chat push
	///   leaves through the server's clear, or when the chat is opened);
	/// - a rollup's thread id is its collapse key and stands for several cards, so only the
	///   per-object and per-workspace threads are judged by their one notification id;
	/// - other workspaces' pushes are not judged: the list is for the selected workspace only.
	///
	/// The caller must only pass a pending list it knows to be complete.
	public static func staleIdentifiers(
		delivered: [DeliveredPush], pendingIds: Set<String>, workspaceId: String
	) -> [String] {
		let pending = Set(pendingIds.map { $0.lowercased() })
		return delivered.compactMap { push in
			guard push.workspaceId?.lowercased() == workspaceId.lowercased(),
				let id = push.notificationId, let thread = push.threadId,
				thread.hasPrefix("object:") || thread.hasPrefix("workspace:"),
				!pending.contains(id.lowercased())
			else { return nil }
			return push.identifier
		}
	}
}
