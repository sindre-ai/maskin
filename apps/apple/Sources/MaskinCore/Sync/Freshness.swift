import Foundation

/// How current a store's data is, for the unobtrusive "Updated 3 min ago" line and the stale
/// indicator. A plain value so views and tests read it without touching a store.
public struct Freshness: Sendable, Equatable {
	public enum Source: Sendable, Equatable {
		/// Nothing shown yet.
		case none
		/// Hydrated from disk; a revalidate has not finished.
		case cache
		/// Confirmed by the server.
		case network
	}

	public private(set) var source: Source = .none
	/// When the data shown was last known to be true (cache's `savedAt`, or the last success).
	public private(set) var updatedAt: Date?
	/// The latest revalidate failed; what is shown is the last good data.
	public private(set) var lastRevalidateFailed = false

	public init() {}

	public mutating func hydrated(from savedAt: Date) {
		source = .cache
		updatedAt = savedAt
	}

	public mutating func refreshed(at date: Date) {
		source = .network
		updatedAt = date
		lastRevalidateFailed = false
	}

	/// A revalidate failed. Keeps the data and its timestamp.
	public mutating func revalidateFailed() { lastRevalidateFailed = true }

	public mutating func reset() { self = Freshness() }

	/// Data on screen that the server has not confirmed this session, or whose last refresh failed.
	public var isStale: Bool { source == .cache || (source != .none && lastRevalidateFailed) }

	/// "Updated 3 min ago", or nil when there is nothing to say yet.
	public func label(now: Date = Date()) -> String? {
		guard let updatedAt else { return nil }
		let seconds = max(0, now.timeIntervalSince(updatedAt))
		if seconds < 60 { return "Updated just now" }
		let formatter = RelativeDateTimeFormatter()
		formatter.unitsStyle = .short
		return "Updated " + formatter.localizedString(for: updatedAt, relativeTo: now)
	}
}
