import Foundation

#if os(iOS) && canImport(ActivityKit)
	import ActivityKit
#endif

/// The opt-in "Following an agent" Live Activity (v3 design). It replaces the automatic Agents
/// card: a session can run for hours, so the card exists only when the person chose to follow one
/// agent from its working banner. It shows elapsed time and the latest step instead of a progress
/// bar (a session has no known finish), and ends when the agent finishes (then it offers Review
/// for `finishedLinger`) or when the person stops following.
public struct FollowActivityState: Codable, Hashable, Sendable {
	public enum Phase: String, Codable, Sendable, Equatable {
		case following
		/// The agent's session ended. The card stays so Review is one tap away.
		case finished
	}

	public static let maxNameLength = 40
	public static let maxDoingLength = 80
	/// How long the finished card offers Review.
	public static let finishedLinger: TimeInterval = 15 * 60
	/// A card the app can no longer update goes stale after this long.
	public static let staleAfter: TimeInterval = 15 * 60

	public var agentName: String
	/// The conversation's title, when the work happens in a chat.
	public var topic: String?
	/// What the agent is doing, one line, present participle ("running the booking tests").
	public var doing: String
	/// The timer on the card; rendered by the system.
	public var startedAt: Date
	public var phase: Phase

	public init(agentName: String, topic: String? = nil, doing: String, startedAt: Date, phase: Phase = .following) {
		let name = agentName.trimmingCharacters(in: .whitespacesAndNewlines)
		self.agentName = name.isEmpty ? "Agent" : Self.cut(name, Self.maxNameLength)
		let title = topic?.trimmingCharacters(in: .whitespacesAndNewlines)
		self.topic = title?.isEmpty == false ? Self.cut(title!, WorkingAgent.maxTopicLength) : nil
		let step = doing.trimmingCharacters(in: .whitespacesAndNewlines)
		self.doing = step.isEmpty ? "working" : Self.cut(step, Self.maxDoingLength)
		self.startedAt = startedAt
		self.phase = phase
	}

	/// The card for an agent that is working right now.
	public init(following agent: WorkingAgent, phase: Phase = .following) {
		self.init(
			agentName: agent.name, topic: agent.topic, doing: agent.doing, startedAt: agent.startedAt, phase: phase)
	}

	/// "Developer · Webhook dedup fix", or just the name when the work has no topic.
	public var title: String {
		guard let topic else { return agentName }
		return "\(agentName) \u{00B7} \(topic)"
	}

	/// "Now: running the booking tests".
	public var nowLine: String { "Now: \(WorkingAgent.lowered(doing))" }

	/// "Developer finished". No result line: the session carries no summary of what it produced.
	public var finishedTitle: String { "\(agentName) finished" }

	public var isFinished: Bool { phase == .finished }

	private static func cut(_ text: String, _ limit: Int) -> String {
		text.count > limit ? String(text.prefix(limit - 1)) + "\u{2026}" : text
	}
}

/// What the activity needs to open the right place and to be addressed by Stop following.
public struct FollowTarget: Codable, Hashable, Sendable {
	public var sessionId: String
	public var workspaceId: String
	public var agentId: String
	public var objectId: String?
	public var conversationId: String?

	public init(
		sessionId: String, workspaceId: String, agentId: String, objectId: String? = nil,
		conversationId: String? = nil
	) {
		self.sessionId = sessionId
		self.workspaceId = workspaceId
		self.agentId = agentId
		self.objectId = objectId
		self.conversationId = conversationId
	}

	public init(_ agent: WorkingAgent, workspaceId: String) {
		self.init(
			sessionId: agent.sessionId, workspaceId: workspaceId, agentId: agent.id, objectId: agent.objectId,
			conversationId: agent.conversationId)
	}

	/// Where Open and Review go: the object, else the conversation, else the agent.
	public var openURL: URL {
		if let objectId { return DeepLink.object(workspaceId: workspaceId, id: objectId).url }
		if let conversationId { return DeepLink.chat(workspaceId: workspaceId, id: conversationId).url }
		return DeepLink.agent(workspaceId: workspaceId, id: agentId).url
	}
}

#if os(iOS) && canImport(ActivityKit)
	public struct MaskinFollowAttributes: ActivityAttributes {
		public typealias ContentState = FollowActivityState

		public let target: FollowTarget

		public init(target: FollowTarget) { self.target = target }

		public var openURL: URL { target.openURL }
	}
#endif
