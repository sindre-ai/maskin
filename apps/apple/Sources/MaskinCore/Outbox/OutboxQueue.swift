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

	/// What the list shows, top to bottom: the writes still waiting, then the ones that could not
	/// be sent. A section is left out when it has no rows; none at all means the empty state.
	public enum Section: Hashable, Sendable { case waiting, couldNotSend }

	public var sections: [Section] {
		(entries.isEmpty ? [] : [.waiting]) + (failures.isEmpty ? [] : [.couldNotSend])
	}

	/// What a person can do with a write that could not be sent. Only dismiss today: the server
	/// refused it, so sending it again would be refused the same way.
	public enum FailureChoice: Hashable, Sendable { case dismiss }

	public func choices(for failure: OutboxFailure) -> [FailureChoice] { [.dismiss] }

	public func perform(_ choice: FailureChoice, on failure: OutboxFailure) {
		switch choice {
		case .dismiss: dismissFailure(failure.id)
		}
	}

	public func dismissFailure(_ id: UUID) {
		for outbox in outboxes { outbox.dismissFailure(id) }
	}
}
