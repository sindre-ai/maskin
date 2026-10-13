import Foundation
import MaskinAPI

/// One agent-turn Live Activity as the device sees it, stripped of ActivityKit types so the
/// sweep decision is a pure function.
public struct TurnActivityCard: Equatable, Sendable {
	public var sessionId: String
	public var workspaceId: String
	public var agentName: String
	public var startedAt: Date
	/// ActivityKit marked it stale: no update arrived before its `staleDate`.
	public var isStale: Bool

	public init(
		sessionId: String, workspaceId: String, agentName: String, startedAt: Date, isStale: Bool
	) {
		self.sessionId = sessionId
		self.workspaceId = workspaceId
		self.agentName = agentName
		self.startedAt = startedAt
		self.isStale = isStale
	}
}

/// What the server says about a card's session. A session with no entry in the lookup map is
/// UNKNOWN (offline, auth failure): the sweep never ends a card on a failed lookup alone.
public enum TurnSessionLookup: Equatable, Sendable {
	case status(ChatAgentSession.Status)
	case notFound
}

public enum TurnSweepReason: String, Equatable, Sendable {
	/// The session completed, failed, timed out or paused: nothing is working any more.
	case sessionFinished
	case sessionGone
	case tooOld
	/// Stale and the server could not confirm the session is still going.
	case stale
	/// A newer card exists for the same agent.
	case superseded
}

public struct TurnSweepPlan: Equatable, Sendable {
	public var ends: [End]
	/// Stale cards whose session the server confirms is still live: pushed a fresh `staleDate`.
	public var refreshes: [String]

	public struct End: Equatable, Sendable {
		public var sessionId: String
		public var reason: TurnSweepReason
		public init(sessionId: String, reason: TurnSweepReason) {
			self.sessionId = sessionId
			self.reason = reason
		}
	}

	public init(ends: [End] = [], refreshes: [String] = []) {
		self.ends = ends
		self.refreshes = refreshes
	}
}

/// Decides which Live Activity cards are dead weight. Cards started by a backend push-to-start
/// are only ever ended by a backend `end` push, which is lost whenever the device never
/// registered that activity's update token (app not running when it started, offline, token
/// churn). This sweep is the app-side backstop.
public enum TurnActivitySweep {
	/// The backend's session timeout is 2h; a card older than that plus a grace period cannot be
	/// showing a live turn, whatever the server says.
	public static let maxAge: TimeInterval = 2 * 3600 + 10 * 60

	public static func plan(
		cards: [TurnActivityCard], lookups: [String: TurnSessionLookup], now: Date
	) -> TurnSweepPlan {
		var plan = TurnSweepPlan()
		var survivors: [TurnActivityCard] = []
		for card in cards {
			let lookup = lookups[card.sessionId]
			if let reason = deadReason(card, lookup: lookup, now: now) {
				plan.ends.append(.init(sessionId: card.sessionId, reason: reason))
				continue
			}
			if card.isStale, case .status = lookup { plan.refreshes.append(card.sessionId) }
			survivors.append(card)
		}
		// At most one live card per agent in a workspace: keep the newest.
		let groups = Dictionary(grouping: survivors) { "\($0.workspaceId)\u{1F}\($0.agentName)" }
		for group in groups.values where group.count > 1 {
			let newest = group.max { $0.startedAt < $1.startedAt }
			for card in group where card.sessionId != newest?.sessionId {
				plan.ends.append(.init(sessionId: card.sessionId, reason: .superseded))
				plan.refreshes.removeAll { $0 == card.sessionId }
			}
		}
		return plan
	}

	private static func deadReason(
		_ card: TurnActivityCard, lookup: TurnSessionLookup?, now: Date
	) -> TurnSweepReason? {
		switch lookup {
		case .notFound: return .sessionGone
		case .status(let status) where !status.isLive: return .sessionFinished
		default: break
		}
		if now.timeIntervalSince(card.startedAt) > maxAge { return .tooOld }
		if card.isStale && lookup == nil { return .stale }
		return nil
	}
}

/// Where the sweep learns the truth. A protocol so the coordinator tests without a server.
public protocol TurnSessionLooking: Sendable {
	/// `nil` means unknown (network or auth failure), never "gone".
	func lookup(sessionId: String, workspaceId: String) async -> TurnSessionLookup?
}

/// `GET /api/sessions/{id}`, with the card's own workspace in the header (a card may outlive a
/// workspace switch). 404 is the only answer that means "gone".
public struct APITurnSessionLookup: TurnSessionLooking {
	private let client: Client
	public init(client: Client) { self.client = client }

	public func lookup(sessionId: String, workspaceId: String) async -> TurnSessionLookup? {
		guard DeepLink.isSafeID(sessionId), DeepLink.isSafeID(workspaceId) else { return nil }
		let output = try? await client.get_sol_api_sol_sessions_sol__lcub_id_rcub_(
			.init(
				path: .init(id: sessionId),
				headers: .init(x_hyphen_workspace_hyphen_id: workspaceId)))
		switch output {
		case .ok(let ok):
			guard let body = try? ok.body.json else { return nil }
			return .status(.init(body.status))
		case .notFound: return .notFound
		default: return nil
		}
	}
}
