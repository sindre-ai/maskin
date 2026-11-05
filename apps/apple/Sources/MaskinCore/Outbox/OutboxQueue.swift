import Foundation

/// Everything the app has queued to send, across the For you and Chats outboxes, for the offline
/// banner's "View" list (review screen 2o). Read-only apart from dismissing a failure.
@MainActor
public struct OutboxQueue {
	public let outboxes: [Outbox]

	public init(outboxes: [Outbox]) { self.outboxes = outboxes }

	/// Waiting to send, oldest first, so the list reads in the order it will go out.
	public var entries: [OutboxEntry] {
		outboxes.flatMap(\.entries).sorted { $0.createdAt < $1.createdAt }
	}

	/// Writes that were dropped (the server refused them), newest first.
	public var failures: [OutboxFailure] {
		outboxes.flatMap(\.failures).sorted { $0.at > $1.at }
	}

	public func dismissFailure(_ id: UUID) {
		for outbox in outboxes { outbox.dismissFailure(id) }
	}
}
