import Foundation

/// How the Chats list is bucketed (the Display menu's "Group by"). Grouping by loop needs a loop
/// on the conversation, which the API doesn't send yet, so it isn't offered.
public enum ConversationGroupBy: String, CaseIterable, Sendable, Identifiable {
	case recent, agent

	public var id: String { rawValue }
	public var title: String {
		switch self {
		case .recent: "Recent"
		case .agent: "Agent"
		}
	}
}

/// What the Chats list shows: pinned chats as tiles on top, then the rest in labelled groups. A
/// pinned chat is not repeated below.
public struct ConversationListSections: Equatable, Sendable {
	public var pinned: [ConversationSummary]
	public var groups: [ConversationGroup]
	public var isEmpty: Bool { pinned.isEmpty && groups.isEmpty }
}

extension ConversationGrouping {
	/// Pinned chats separated out (most recent first), everything else grouped by `by`.
	public static func sections(
		_ conversations: [ConversationSummary], by: ConversationGroupBy, currentActorID: String?,
		now: Date = Date(), calendar: Calendar = .current
	) -> ConversationListSections {
		let pinned = conversations.filter(\.pinned)
			.sorted { ($0.activityDate ?? .distantPast) > ($1.activityDate ?? .distantPast) }
		let rest = conversations.filter { !$0.pinned }
		switch by {
		case .recent:
			return ConversationListSections(
				pinned: pinned, groups: group(rest, now: now, calendar: calendar))
		case .agent:
			return ConversationListSections(
				pinned: pinned, groups: groupByAgent(rest, currentActorID: currentActorID))
		}
	}

	/// One group per agent, groups ordered by their newest chat. Chats with no agent in them go
	/// under "People".
	static func groupByAgent(_ conversations: [ConversationSummary], currentActorID: String?)
		-> [ConversationGroup]
	{
		let sorted = conversations.sorted {
			($0.activityDate ?? .distantPast) > ($1.activityDate ?? .distantPast)
		}
		var order: [ConversationGroup.Key] = []
		var buckets: [ConversationGroup.Key: ConversationGroup] = [:]
		for c in sorted {
			let agent = c.primaryAgent(excluding: currentActorID)
			let key = ConversationGroup.Key(rawValue: "agent-\(agent?.id ?? "people")")
			if buckets[key] == nil {
				order.append(key)
				buckets[key] = ConversationGroup(key: key, label: agent?.name ?? "People", items: [])
			}
			buckets[key]?.items.append(c)
		}
		return order.compactMap { buckets[$0] }
	}
}

extension ConversationSummary {
	/// The people and agents other than the signed-in person; everyone when that leaves no one.
	public func others(excluding actorID: String?) -> [ChatParticipant] {
		let rest = participants.filter { $0.id != actorID }
		return rest.isEmpty ? participants : rest
	}

	/// The first agent besides you, if any.
	public func primaryAgent(excluding actorID: String?) -> ChatParticipant? {
		others(excluding: actorID).first { $0.kind == .agent }
	}

	/// More than one other party: the row shows a two-avatar cluster and the last sender's name.
	public func isGroupChat(excluding actorID: String?) -> Bool {
		participants.filter { $0.id != actorID }.count > 1
	}

	/// Who the row is "with": the agents, else the other people.
	public func counterpartName(excluding actorID: String?) -> String {
		let rest = others(excluding: actorID)
		let agents = rest.filter { $0.kind == .agent }
		let names = (agents.isEmpty ? rest : agents).map(\.name)
		return names.isEmpty ? title : names.joined(separator: ", ")
	}
}

/// Time on a Chats row, the Messages way: a clock time today, "Yesterday", a weekday within the
/// past week, then "Sep 29".
public enum ChatListTime {
	public static func label(
		for date: Date, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current
	) -> String {
		let days =
			calendar.dateComponents(
				[.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)
			).day ?? 0
		let base = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
		switch days {
		case ...0:
			return date.formatted(
				Date.FormatStyle(
					date: .omitted, time: .shortened, locale: locale, calendar: calendar,
					timeZone: calendar.timeZone))
		case 1:
			return "Yesterday"
		case 2...6:
			return date.formatted(base.weekday(.abbreviated))
		default:
			return date.formatted(base.month(.abbreviated).day())
		}
	}
}

/// A role line for the People sheet: "Human · Owner", "Agent · CPO".
public enum PersonRoleLabel {
	/// Agents describe themselves on their first description line; only a short one reads as a
	/// role ("CPO"), a sentence is left out.
	static let maxAgentRoleLength = 32

	public static func label(
		for participant: ChatParticipant, memberRole: String?, agentSummary: String?
	) -> String {
		switch participant.kind {
		case .human:
			guard let memberRole, !memberRole.isEmpty else { return "Human" }
			return "Human · \(memberRole.prefix(1).uppercased() + memberRole.dropFirst())"
		case .agent:
			let role = AgentSummary.role(from: agentSummary)
			guard role != "Agent", role.count <= maxAgentRoleLength else { return "Agent" }
			return "Agent · \(role)"
		}
	}
}

/// A sub-agent session shown between messages: an agent that was handed work by another agent.
public struct ChatHandoff: Identifiable, Equatable, Sendable {
	public var id: String { sessionID }
	public var sessionID: String
	public var agentID: String
	/// The message that handed the work over; the row sits right after it.
	public var triggerMessageID: Int
	public var title: String
	public var status: ChatAgentSession.Status
	public var startedAt: Date?

	public init(
		sessionID: String, agentID: String, triggerMessageID: Int, title: String,
		status: ChatAgentSession.Status, startedAt: Date? = nil
	) {
		self.sessionID = sessionID
		self.agentID = agentID
		self.triggerMessageID = triggerMessageID
		self.title = title
		self.status = status
		self.startedAt = startedAt
	}
}

public enum ChatHandoffs {
	static let maxTitleLength = 90

	/// Sessions started by another agent's message. A session a person kicked off, or an agent
	/// answering its own message, is an ordinary turn and stays out. The task title is the first
	/// line of the handing-over message, as plain text.
	public static func handoffs(sessions: [ChatAgentSession], messages: [ChatMessage]) -> [ChatHandoff] {
		let byServerID = Dictionary(
			messages.compactMap { m in m.serverID.map { ($0, m) } }, uniquingKeysWith: { first, _ in first })
		return sessions.compactMap { session in
			guard let id = session.messageID, let trigger = byServerID[id], trigger.author == .agent,
				trigger.actorID != session.actorID
			else { return nil }
			return ChatHandoff(
				sessionID: session.id, agentID: session.actorID, triggerMessageID: id,
				title: title(from: trigger.content), status: session.status, startedAt: session.startedAt)
		}
		.sorted { ($0.startedAt ?? .distantPast) < ($1.startedAt ?? .distantPast) }
	}

	static func title(from content: String) -> String {
		let line =
			content.split(whereSeparator: \.isNewline).map { String($0) }
			.first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? content
		let plain = ChatPreviewText.plain(line)
		return plain.count > maxTitleLength ? String(plain.prefix(maxTitleLength)) + "…" : plain
	}
}

/// The group header pill under a thread's title: "You, Sebastian, Chief of Staff +2".
public enum GroupChatSummary {
	/// You first, then the others in order; past `limit` names the rest are counted.
	public static func names(of participants: [ChatParticipant], selfID: String, limit: Int = 3)
		-> String
	{
		let me = participants.contains { $0.id == selfID }
		var names = (me ? ["You"] : []) + participants.filter { $0.id != selfID }.map(\.name)
		guard names.count > limit else { return names.joined(separator: ", ") }
		let extra = names.count - limit
		names = Array(names.prefix(limit))
		return names.joined(separator: ", ") + " +\(extra)"
	}

	/// Who the overlapping avatars show: up to four, the other people first.
	public static func avatarParticipants(of participants: [ChatParticipant], selfID: String, limit: Int = 4)
		-> [ChatParticipant]
	{
		let others = participants.filter { $0.id != selfID }
		let me = participants.filter { $0.id == selfID }
		return Array((others + me).prefix(limit))
	}
}
