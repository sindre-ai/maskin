/// How an agent's words sit in a thread: plain text on the page, no bubble, no avatar, no time
/// (v3). In a one-to-one chat nothing else is needed, because the title already says who is
/// speaking; once the chat has more than one other party, a quiet name label above the first
/// message of a run tells the agents apart.
public enum AgentRowStyle {
	/// What a row draws around its words.
	public struct Row: Equatable, Sendable {
		/// A card surface behind the words (a person's message; never an agent's).
		public var bubble: Bool
		/// The avatar + name + time header (a person's message; never an agent's).
		public var header: Bool
		/// The quiet name line (an agent's first message of a run, in a chat with several agents).
		public var nameLabel: Bool
	}

	/// The shape of a message row. The finished message and the streaming reply it becomes both
	/// ask this with the same arguments, so they are the same shape and the text does not move
	/// when the stream lands.
	public static func row(author: ChatParticipant.Kind, showsAuthor: Bool, namesAgent: Bool) -> Row {
		switch author {
		case .agent: Row(bubble: false, header: false, nameLabel: showsAuthor && namesAgent)
		case .human: Row(bubble: true, header: showsAuthor, nameLabel: false)
		}
	}

	/// The streaming reply: always the first line of an agent's run.
	public static func streamingRow(namesAgent: Bool) -> Row {
		row(author: .agent, showsAuthor: true, namesAgent: namesAgent)
	}

	/// Whether an agent's name is shown above its words. It is hidden only when the chat is known
	/// to be a one-to-one: the participants have loaded and exactly one party besides you has
	/// taken part, counting agents that spoke in the loaded history but have since left. Until the
	/// participants load (an empty list) names stay, so a row never loses its name and then has it
	/// pop back; an agent that left a group does not make the old names vanish either.
	public static func namesAgents(
		participants: [ChatParticipant], currentActorID: String?, agentAuthorIDs: [String] = []
	) -> Bool {
		guard !participants.isEmpty else { return true }
		var others = Set(participants.map(\.id)).union(agentAuthorIDs)
		if let currentActorID { others.remove(currentActorID) }
		return others.count != 1
	}
}
