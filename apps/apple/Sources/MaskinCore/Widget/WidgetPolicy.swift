import Foundation

/// Freshness, relevance and refresh rules for the widgets. Pure, so they test without WidgetKit.
public enum WidgetPolicy {
	/// How often a healthy widget asks for a fresh snapshot. WidgetKit budgets reloads and may
	/// stretch this; the app also reloads on demand (`WidgetReloader`).
	public static let refreshInterval: TimeInterval = 30 * 60
	/// After a failed fetch: sooner, so a blip on a train doesn't leave the widget stale for 15 min.
	public static let retryInterval: TimeInterval = 5 * 60
	/// Signed out: nothing to poll for. The app reloads the widget the moment someone signs in.
	public static let signedOutInterval: TimeInterval = 60 * 60
	/// Past this the widget says "Updated 40m ago" in a warning colour instead of in grey.
	public static let staleAfter: TimeInterval = 30 * 60
	/// Past this a cached snapshot is dropped from view rather than shown as if it were current.
	public static let expireAfter: TimeInterval = 12 * 60 * 60
	/// A snapshot written by this very load has an age of a few seconds at most.
	static let justFetched: TimeInterval = 60

	public static func age(of snapshot: WidgetSnapshot, at date: Date) -> TimeInterval {
		max(0, date.timeIntervalSince(snapshot.updatedAt))
	}

	public static func isStale(_ snapshot: WidgetSnapshot, at date: Date) -> Bool {
		age(of: snapshot, at: date) >= staleAfter
	}

	public static func isExpired(_ snapshot: WidgetSnapshot, at date: Date) -> Bool {
		age(of: snapshot, at: date) >= expireAfter
	}

	/// Smart Stack relevance, 0...1. Nothing to do scores 0, so the stack rotates it away;
	/// decisions rank above everything and grow with the queue, capped so one huge backlog
	/// doesn't pin the widget on top forever.
	public static func relevance(of state: WidgetState) -> Float {
		guard case .content(let snapshot) = state else { return 0 }
		if snapshot.needsCount > 0 { return min(1, 0.6 + 0.1 * Float(min(snapshot.needsCount, 4))) }
		return snapshot.unreadCount > 0 ? 0.2 : 0
	}

	/// What to hand WidgetKit: the entry dates and when to ask again.
	public struct Plan: Sendable, Equatable {
		public var entries: [Date]
		public var reloadAfter: Date
	}

	public static func plan(for state: WidgetState, now: Date) -> Plan {
		switch state {
		case .signedOut:
			return Plan(entries: [now], reloadAfter: now.addingTimeInterval(signedOutInterval))
		case .unavailable:
			return Plan(entries: [now], reloadAfter: now.addingTimeInterval(retryInterval))
		case .content(let snapshot):
			// Fetched just now: normal cadence. Anything older is a cached fallback after a
			// failed fetch: retry soon, and add entries where it turns stale and where it expires so
			// the widget changes by itself even if no reload ever succeeds.
			let fresh = age(of: snapshot, at: now) < justFetched
			// The stale and expiry entries are always scheduled, fresh or not: if the next reload
			// never succeeds the widget still ages and degrades by itself.
			var entries = [now]
			for threshold in [staleAfter, expireAfter] {
				let at = snapshot.updatedAt.addingTimeInterval(threshold)
				if at > now { entries.append(at) }
			}
			return Plan(
				entries: entries,
				reloadAfter: now.addingTimeInterval(fresh ? refreshInterval : retryInterval))
		}
	}
}
