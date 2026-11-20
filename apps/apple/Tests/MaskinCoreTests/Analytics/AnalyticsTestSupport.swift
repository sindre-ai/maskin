import Foundation

@testable import MaskinCore

/// Records every batch an `Analytics` sends, and fails on demand.
final class RecordingAnalyticsTransport: AnalyticsTransport, @unchecked Sendable {
	private let lock = NSLock()
	private var recorded: [(workspaceId: String, events: [AnalyticsEvent])] = []
	private var failure: (any Error)?

	var batches: [(workspaceId: String, events: [AnalyticsEvent])] { lock.withLock { recorded } }
	var sent: [AnalyticsEvent] { batches.flatMap(\.events) }
	var names: [String] { sent.map(\.name) }

	func fail(with error: (any Error)?) { lock.withLock { failure = error } }

	func send(_ events: [AnalyticsEvent], workspaceId: String) async throws {
		try lock.withLock {
			if let failure { throw failure }
			recorded.append((workspaceId, events))
		}
	}
}

struct TransientFailure: Error {}

/// An `Analytics` that never sends on its own, so a test decides when the queue goes out.
@MainActor
func makeAnalytics(
	storage: InMemoryAnalyticsStorage = InMemoryAnalyticsStorage(),
	now: Date = Date(timeIntervalSince1970: 1_800_000_000), signedIn: Bool = true
) -> (Analytics, RecordingAnalyticsTransport, InMemoryAnalyticsStorage) {
	let transport = RecordingAnalyticsTransport()
	let analytics = Analytics()
	analytics.configure(transport: transport, storage: storage, clock: { now }, sendsOnItsOwn: false)
	if signedIn { analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1") }
	return (analytics, transport, storage)
}
