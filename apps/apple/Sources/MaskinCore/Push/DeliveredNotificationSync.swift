import Foundation
import MaskinAPI

#if os(iOS)
	import UserNotifications
#endif

/// The notifications our server delivered that are still on this device, and removing them.
public protocol DeliveredNotificationCenter: Sendable {
	func delivered() async -> [DeliveredPush]
	func remove(identifiers: [String]) async
}

/// The signed-in actor's pending notifications.
public protocol PendingNotificationSource: Sendable {
	/// The pending notification ids, or `nil` when the list can't be trusted (a failed request, or
	/// a full page: more may exist, and a delivered push missing from it is not proof it is handled).
	func pendingNotificationIds(workspaceId: String) async -> Set<String>?
}

/// Keeps the lock screen and the icon badge in step with what is still pending. The server's clear
/// push is the fast half; this is the reliable half, run on every foreground and when the person
/// answers or opens something inside the app without tapping the notification.
@MainActor
public final class DeliveredNotificationSync {
	private let center: any DeliveredNotificationCenter
	private let pending: any PendingNotificationSource
	private let workspaceId: @MainActor () -> String?
	private let setBadge: @MainActor (Int) -> Void

	public init(
		center: any DeliveredNotificationCenter, pending: any PendingNotificationSource,
		workspaceId: @escaping @MainActor () -> String?, setBadge: @escaping @MainActor (Int) -> Void
	) {
		self.center = center
		self.pending = pending
		self.workspaceId = workspaceId
		self.setBadge = setBadge
	}

	/// Remove every delivered push whose notification is no longer pending, then set the badge to
	/// the pending count. Does nothing if the list could not be read.
	public func reconcile() async {
		guard let workspaceId = workspaceId() else { return }
		// Delivered first: a push that lands while the request is out is then newer than the list,
		// and is not judged against it.
		let delivered = await center.delivered()
		guard let pendingIds = await pending.pendingNotificationIds(workspaceId: workspaceId) else { return }
		let stale = DeliveredSweep.staleIdentifiers(
			delivered: delivered, pendingIds: pendingIds, workspaceId: workspaceId)
		if !stale.isEmpty { await center.remove(identifiers: stale) }
		setBadge(pendingIds.count)
	}

	/// The person answered or dismissed a card in the app: drop its pushes.
	public func cardHandled(objectId: String) async {
		await removeThread("object:\(objectId)")
	}

	/// The person opened a chat in the app: drop its pushes.
	public func chatOpened(conversationId: String) async {
		await removeThread("chat:\(conversationId)")
	}

	private func removeThread(_ thread: String) async {
		let ids = await center.delivered().filter { $0.threadId == thread }.map(\.identifier)
		if !ids.isEmpty { await center.remove(identifiers: ids) }
	}
}

/// `GET /api/notifications?status=pending`, one page.
public struct APIPendingNotificationSource: PendingNotificationSource {
	public static let pageLimit = 100
	private let client: Client

	public init(client: Client) { self.client = client }

	public func pendingNotificationIds(workspaceId: String) async -> Set<String>? {
		guard
			let output = try? await client.get_sol_api_sol_notifications(
				query: .init(status: "pending", limit: Self.pageLimit),
				headers: .init(x_hyphen_workspace_hyphen_id: workspaceId)),
			case .ok(let ok) = output, let list = try? ok.body.json,
			list.count < Self.pageLimit
		else { return nil }
		return Set(list.map(\.id))
	}
}

#if os(iOS)
	/// `DeliveredNotificationCenter` over `UNUserNotificationCenter`.
	public struct SystemDeliveredNotificationCenter: DeliveredNotificationCenter {
		public init() {}

		public func delivered() async -> [DeliveredPush] {
			await UNUserNotificationCenter.current().deliveredNotifications().map { notification in
				let content = notification.request.content
				return DeliveredPush(
					identifier: notification.request.identifier,
					notificationId: content.userInfo["notification_id"] as? String,
					threadId: content.threadIdentifier.isEmpty ? nil : content.threadIdentifier,
					workspaceId: content.userInfo["workspace_id"] as? String)
			}
		}

		public func remove(identifiers: [String]) async {
			UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: identifiers)
		}

		/// For a background clear push, which can wake the app before any runtime exists.
		public func setBadge(_ count: Int) async {
			try? await UNUserNotificationCenter.current().setBadgeCount(max(0, count))
		}
	}
#endif
