import Foundation

/// Everything a widget draws, in a few hundred bytes: no cards, no markdown, no ids that render.
/// Built from the same feed the For You screen reads (see `WidgetSnapshotBuilder`) so the widget
/// says "needs you" about exactly the cards For You puts in its first bucket.
public struct WidgetSnapshot: Codable, Sendable, Equatable {
	/// One decision an agent is waiting on.
	public struct Decision: Codable, Sendable, Equatable, Identifiable {
		public var objectId: String
		public var title: String
		/// Who asked, resolved to a name. `nil` when the name could not be resolved: a widget says
		/// nothing rather than printing an id.
		public var agentName: String?
		/// The agent's own option labels (at most `WidgetSnapshot.maxOptions`), recommended first.
		public var optionLabels: [String]
		public var recommendedLabel: String?
		/// When the card last had activity; drives the "held 3 days" note.
		public var since: Date?
		public var id: String { objectId }

		public init(
			objectId: String, title: String, agentName: String? = nil, optionLabels: [String] = [],
			recommendedLabel: String? = nil, since: Date? = nil
		) {
			self.objectId = objectId
			self.title = title
			self.agentName = agentName
			self.optionLabels = optionLabels
			self.recommendedLabel = recommendedLabel
			self.since = since
		}
	}

	/// The most decisions a snapshot carries (the large widget's rows).
	public static let maxDecisions = 3
	public static let maxOptions = 3
	public static let maxTitleLength = 140

	/// Whose data this is. Never rendered; a snapshot for another actor is discarded.
	public var actorId: String
	public var workspaceId: String
	/// Every decision awaiting the reader, not just the ones in `decisions`.
	public var needsCount: Int
	/// The most urgent first (the feed's own order), capped at `maxDecisions`.
	public var decisions: [Decision]
	/// Unread notifications. Capped by the one page the loader asks for: see `unreadCap`.
	public var unreadCount: Int
	public var updatedAt: Date

	/// The server list is one page of this size, so `unreadCount == unreadCap` means "at least".
	public static let unreadCap = 100

	public init(
		actorId: String, workspaceId: String, needsCount: Int, decisions: [Decision],
		unreadCount: Int, updatedAt: Date
	) {
		self.actorId = actorId
		self.workspaceId = workspaceId
		self.needsCount = max(0, needsCount)
		self.decisions = Array(decisions.prefix(Self.maxDecisions))
		self.unreadCount = max(0, unreadCount)
		self.updatedAt = updatedAt
	}

	public var top: Decision? { decisions.first }
	public var isEmpty: Bool { needsCount == 0 }

	/// "99+" once the count may be larger than the page the loader read.
	public var unreadLabel: String {
		unreadCount >= Self.unreadCap ? "\(Self.unreadCap - 1)+" : "\(unreadCount)"
	}

	/// Where a tap on a decision goes: the object, via the app's own `DeepLink` shape.
	public func url(for decision: Decision) -> URL {
		DeepLink.object(workspaceId: workspaceId, id: decision.objectId).url
	}

	/// Where a tap on the count (or the empty state) goes: the top decision if there is one, else
	/// the notifications inbox.
	public var tapURL: URL {
		if let top { return url(for: top) }
		return DeepLink.notifications(workspaceId: workspaceId).url
	}
}

/// What a widget is showing, before presentation.
public enum WidgetState: Sendable, Equatable {
	/// No session (or the key was revoked, or no workspace picked): "Open Maskin to sign in".
	case signedOut
	case content(WidgetSnapshot)
	/// Nothing cached and the network failed.
	case unavailable
}

extension WidgetState {
	/// The state as it should be drawn at `date`: a cached snapshot older than
	/// `WidgetPolicy.expireAfter` is not trusted any more (decisions it lists have likely been
	/// answered elsewhere), so it degrades to `.unavailable`.
	public func resolved(at date: Date) -> WidgetState {
		guard case .content(let snapshot) = self else { return self }
		return WidgetPolicy.isExpired(snapshot, at: date) ? .unavailable : self
	}
}
