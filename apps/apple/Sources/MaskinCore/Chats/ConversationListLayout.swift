import Foundation

/// How the Team list is laid out (the Display menu): one row per person or agent under UNREAD and
/// PEOPLE & AGENTS, or every conversation on its own row, newest first, in day groups.
public enum ConversationGroupBy: String, CaseIterable, Sendable, Identifiable {
	case person, recent

	public var id: String { rawValue }
	public var title: String {
		switch self {
		case .person: "By person"
		case .recent: "One list"
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
	/// Pinned chats separated out (most recent first), everything else in day groups: the flat
	/// list. The person view is `teamSections`.
	public static func sections(
		_ conversations: [ConversationSummary], now: Date = Date(), calendar: Calendar = .current
	) -> ConversationListSections {
		let pinned = conversations.filter(\.pinned)
			.sorted { ($0.activityDate ?? .distantPast) > ($1.activityDate ?? .distantPast) }
		let rest = conversations.filter { !$0.pinned }
		return ConversationListSections(pinned: pinned, groups: group(rest, now: now, calendar: calendar))
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
