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
		/// The agent's decision comment, which an answer threads under. `nil` (an older cache, or a
		/// card without one) means the widget cannot answer in place and opens the app instead.
		public var eventId: Int?
		/// Options that need the confirm sheet (irreversible). They open the app, never act.
		public var confirmLabels: [String]
		public var id: String { objectId }

		public init(
			objectId: String, title: String, agentName: String? = nil, optionLabels: [String] = [],
			recommendedLabel: String? = nil, since: Date? = nil, eventId: Int? = nil,
			confirmLabels: [String] = []
		) {
			self.eventId = eventId
			self.confirmLabels = confirmLabels
			self.objectId = objectId
			self.title = title
			self.agentName = agentName
			self.optionLabels = optionLabels
			self.recommendedLabel = recommendedLabel
			self.since = since
		}

		// Hand-written so snapshots cached before these fields existed still decode.
		public init(from decoder: any Decoder) throws {
			let c = try decoder.container(keyedBy: CodingKeys.self)
			objectId = try c.decode(String.self, forKey: .objectId)
			title = try c.decode(String.self, forKey: .title)
			agentName = try c.decodeIfPresent(String.self, forKey: .agentName)
			optionLabels = try c.decodeIfPresent([String].self, forKey: .optionLabels) ?? []
			recommendedLabel = try c.decodeIfPresent(String.self, forKey: .recommendedLabel)
			since = try c.decodeIfPresent(Date.self, forKey: .since)
			eventId = try c.decodeIfPresent(Int.self, forKey: .eventId)
			confirmLabels = try c.decodeIfPresent([String].self, forKey: .confirmLabels) ?? []
		}

		/// The button the medium widget leads with: the agent's recommendation, else its first option.
		public var primaryLabel: String? { recommendedLabel ?? optionLabels.first }

		/// The second button: the agent's Hold if it authored one, else the next option.
		public var secondaryLabel: String? {
			let others = optionLabels.filter { $0 != primaryLabel }
			return others.first(where: HoldOption.matches) ?? others.first
		}

		/// Whether tapping `label` may decide in place. Hold needs a reason and irreversible
		/// options need the confirm sheet, so both open the app instead.
		public func decidesInPlace(_ label: String) -> Bool {
			eventId != nil && !HoldOption.matches(label) && !confirmLabels.contains(label)
		}
	}

	/// One running flow, for the large widget's ring tiles.
	public struct Flow: Codable, Sendable, Equatable, Identifiable {
		public var id: String
		public var name: String
		/// Share of the flow's work that has closed, 0...1 (the ring).
		public var progress: Double
		/// A decision in this flow is waiting on the reader: "Needs you" instead of "On track".
		public var needsYou: Bool

		public init(id: String, name: String, progress: Double, needsYou: Bool) {
			self.id = id
			self.name = name
			self.progress = min(max(progress.isFinite ? progress : 0, 0), 1)
			self.needsYou = needsYou
		}
	}

	/// The most flow tiles a snapshot carries.
	public static let maxFlows = 3
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
	/// Up to `maxFlows` running flows, ones that need the reader first. Empty on snapshots cached
	/// before flows were carried.
	public var flows: [Flow]
	/// How many flows are running in all (the empty state's "3 flows running").
	public var runningFlowCount: Int

	/// The server list is one page of this size, so `unreadCount == unreadCap` means "at least".
	public static let unreadCap = 100

	public init(
		actorId: String, workspaceId: String, needsCount: Int, decisions: [Decision],
		unreadCount: Int, updatedAt: Date, flows: [Flow] = [], runningFlowCount: Int? = nil
	) {
		self.flows = Array(flows.prefix(Self.maxFlows))
		self.runningFlowCount = max(0, runningFlowCount ?? flows.count)
		self.actorId = actorId
		self.workspaceId = workspaceId
		self.needsCount = max(0, needsCount)
		self.decisions = Array(decisions.prefix(Self.maxDecisions))
		self.unreadCount = max(0, unreadCount)
		self.updatedAt = updatedAt
	}

	// Hand-written so snapshots cached before flows existed still decode.
	public init(from decoder: any Decoder) throws {
		let c = try decoder.container(keyedBy: CodingKeys.self)
		self.init(
			actorId: try c.decode(String.self, forKey: .actorId),
			workspaceId: try c.decode(String.self, forKey: .workspaceId),
			needsCount: try c.decode(Int.self, forKey: .needsCount),
			decisions: try c.decode([Decision].self, forKey: .decisions),
			unreadCount: try c.decode(Int.self, forKey: .unreadCount),
			updatedAt: try c.decode(Date.self, forKey: .updatedAt),
			flows: try c.decodeIfPresent([Flow].self, forKey: .flows) ?? [],
			runningFlowCount: try c.decodeIfPresent(Int.self, forKey: .runningFlowCount))
	}

	public var top: Decision? { decisions.first }

	/// The snapshot with the decisions the reader has already answered taken out, so the widget
	/// moves on to the next ask without waiting for the next fetch.
	public func removing(objectIds: Set<String>) -> WidgetSnapshot {
		guard !objectIds.isEmpty else { return self }
		let kept = decisions.filter { !objectIds.contains($0.objectId) }
		let removed = decisions.count - kept.count
		return WidgetSnapshot(
			actorId: actorId, workspaceId: workspaceId, needsCount: needsCount - removed,
			decisions: kept, unreadCount: unreadCount, updatedAt: updatedAt, flows: flows,
			runningFlowCount: runningFlowCount)
	}
	public var isEmpty: Bool { needsCount == 0 }

	/// The empty state's second line: "3 flows running" when flows are known, else unread
	/// notifications, else a generic reassurance.
	public var caughtUpDetail: String {
		if runningFlowCount > 0 { return "\(runningFlowCount) \(runningFlowCount == 1 ? "flow" : "flows") running" }
		if unreadCount > 0 { return "\(unreadLabel) unread \(unreadCount == 1 ? "notification" : "notifications")" }
		return "Agents are working. We'll tell you when they need a call."
	}

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
