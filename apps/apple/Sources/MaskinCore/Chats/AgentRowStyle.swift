import Foundation

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
		/// The quiet clock time under an agent's words, on the last message of a run (a person's
		/// message carries its time in the header instead).
		public var time: Bool
	}

	/// The shape of a message row. The finished message and the streaming reply it becomes both
	/// ask this with the same arguments, so everything above the words is the same and the text
	/// does not move when the stream lands. The time sits below the words, so it only ever adds a
	/// line at the end.
	public static func row(
		author: ChatParticipant.Kind, showsAuthor: Bool, namesAgent: Bool, endsRun: Bool = true
	) -> Row {
		switch author {
		case .agent: Row(bubble: false, header: false, nameLabel: showsAuthor && namesAgent, time: endsRun)
		case .human: Row(bubble: true, header: showsAuthor, nameLabel: false, time: false)
		}
	}

	/// The streaming reply: always the first line of an agent's run, and never the last (the
	/// finished message brings its time).
	public static func streamingRow(namesAgent: Bool) -> Row {
		var row = row(author: .agent, showsAuthor: true, namesAgent: namesAgent)
		row.time = false
		return row
	}

	/// What VoiceOver says before an agent's plain words: who wrote them and when. The v3 row draws
	/// neither the avatar nor the time, so this is where the time stays reachable.
	public static func spokenSender(
		name: String, date: Date?, locale: Locale = .current, timeZone: TimeZone = .current
	) -> String {
		guard let date else { return name }
		let style = Date.FormatStyle(date: .abbreviated, time: .shortened, locale: locale, timeZone: timeZone)
		return "\(name), \(date.formatted(style))"
	}

	/// Whether an agent's name is shown above its words. It is hidden only when the chat is known
	/// to be a one-to-one: the participants have loaded and exactly one party besides you has
	/// taken part, counting agents that spoke in the loaded history but have since left. Until the
	/// participants load (an empty list) names stay, so a row never loses its name and then has it
	/// pop back; an agent that left a group does not make the old names vanish either.
	public static func namesAgents(
		participants: [ChatParticipant], currentActorID: String?, agentAuthorIDs: Set<String> = []
	) -> Bool {
		guard !participants.isEmpty else { return true }
		var others = Set(participants.map(\.id)).union(agentAuthorIDs)
		if let currentActorID { others.remove(currentActorID) }
		return others.count != 1
	}
}
