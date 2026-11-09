/// How an agent's words sit in a thread: plain text on the page, no bubble, no avatar, no time
/// (v3). In a one-to-one chat nothing else is needed, because the title already says who is
/// speaking; once the chat has more than one other party, a quiet name label above the first
/// message of a run tells the agents apart.
public enum AgentRowStyle {
	/// True when the chat has more than one party besides you, so an agent's name is shown.
	public static func namesAgents(participants: [ChatParticipant], currentActorID: String?) -> Bool {
		participants.filter { $0.id != currentActorID }.count > 1
	}
}
