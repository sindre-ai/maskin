import Foundation

/// How a tagged person is written in text: `@FirstName`. Shared by the composer (what it inserts),
/// the send path (which tags are still in the text) and the bubble highlighter.
public enum MentionName {
	/// The first word of a name ("Ida Berg" is "Ida"); the whole name when it has one word.
	public static func first(of name: String) -> String {
		name.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? name
	}

	/// What goes into the text for a pick, with the trailing space the user keeps typing after.
	public static func token(for name: String) -> String { "@" + first(of: name) }
}

/// One taggable actor: a member of the workspace or one of its agents.
public struct MentionPerson: Identifiable, Hashable, Sendable {
	public var id: String
	public var name: String
	public var kind: ChatParticipant.Kind
	/// "Human · Owner", "Human · Member" or "Agent": the label on the right of the picker row.
	public var roleLabel: String

	public init(id: String, name: String, kind: ChatParticipant.Kind, roleLabel: String? = nil) {
		self.id = id
		self.name = name
		self.kind = kind
		self.roleLabel = roleLabel ?? (kind == .agent ? "Agent" : "Human")
	}

	public var participant: ChatParticipant { ChatParticipant(id: id, name: name, kind: kind) }
	public var mention: ChatMention { ChatMention(id: id, name: name, kind: kind) }
}

/// Everyone a composer can tag, and the rules for which of them an `@query` offers. Built from the
/// workspace's members and agents so every composer (thread, object timeline, loop, For you reply,
/// Chief of Staff) shows the same list.
public struct MentionRoster: Sendable, Equatable {
	/// Rows the picker shows at most.
	public static let maxRows = 5

	public var people: [MentionPerson]

	public init(people: [MentionPerson]) { self.people = people }

	/// Humans come from the members list (with their role); agents from the agents list, falling
	/// back to the agents the members list carries. Nobody appears twice.
	public init(members: [WorkspaceMember], agents: [AgentSummary] = []) {
		var seen = Set<String>()
		var result: [MentionPerson] = []
		for member in members where !member.isAgent && seen.insert(member.actorId).inserted {
			result.append(
				MentionPerson(
					id: member.actorId, name: member.name, kind: .human,
					roleLabel: "Human · \(member.role.label)"))
		}
		for agent in agents where seen.insert(agent.id).inserted {
			result.append(MentionPerson(id: agent.id, name: agent.name, kind: .agent))
		}
		for member in members where member.isAgent && seen.insert(member.actorId).inserted {
			result.append(MentionPerson(id: member.actorId, name: member.name, kind: .agent))
		}
		self.init(people: result)
	}

	/// Whom `@query` offers: names that start with the query, or whose first name does. People
	/// already in the conversation come first. Never the signed-in actor.
	public func candidates(
		query: String, selfID: String, prioritizing inConversation: Set<String> = [],
		limit: Int = MentionRoster.maxRows
	) -> [MentionPerson] {
		let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive, .anchored]
		func matches(_ person: MentionPerson) -> Bool {
			query.isEmpty
				|| person.name.range(of: query, options: options) != nil
				|| MentionName.first(of: person.name).range(of: query, options: options) != nil
		}
		let found = people.filter { $0.id != selfID && matches($0) }
		let ordered = found.enumerated().sorted { a, b in
			let (x, y) = (inConversation.contains(a.element.id), inConversation.contains(b.element.id))
			if x != y { return x }
			let byName = a.element.name.localizedCaseInsensitiveCompare(b.element.name)
			return byName == .orderedSame ? a.offset < b.offset : byName == .orderedAscending
		}
		return Array(ordered.map(\.element).prefix(limit))
	}

	/// The first names to highlight when rendering text that tags `ids`.
	public func names(for ids: some Sequence<String>) -> [String] {
		let wanted = Set(ids)
		return people.filter { wanted.contains($0.id) }.map(\.name)
	}
}
