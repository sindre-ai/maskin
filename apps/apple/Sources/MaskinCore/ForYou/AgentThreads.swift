import Foundation

/// Opens the reader's chat with ONE specific agent about one subject (an object, a flow): the shared
/// primitive behind For you's reply box and the Flows composer.
///
/// What the backend needs (read from `routes/conversations.ts` and `conversation-responder.ts`):
/// - A chat's participants decide who can hear. `POST /api/conversations` adds the caller, so the
///   participants sent are just the agent (plus anyone the reader @-tagged).
/// - A chat with exactly two active participants (the person and the agent) is "direct": the agent
///   answers every message. With three or more, only an agent named in the message's
///   `metadata.mentions` is woken (the wake rule), so the caller also tags the agent.
/// - A subject-bound chat is one per subject, not per agent, so it cannot give each agent its own
///   chat. A plain conversation titled "About: <subject>" is used instead and found by title.
@MainActor
public enum AgentThreads {
	/// Who the message really goes to. The name is the resolved participant's, never the card's guess.
	public struct Recipient: Equatable, Sendable {
		public var id: String?
		public var name: String
		public var isChiefOfStaff: Bool

		public init(id: String? = nil, name: String, isChiefOfStaff: Bool) {
			self.id = id
			self.name = name
			self.isChiefOfStaff = isChiefOfStaff
		}

		public static let chiefOfStaff = Recipient(name: "Chief of Staff", isChiefOfStaff: true)
	}

	public struct Opened: Equatable {
		public var outcome: ChiefOfStaffThreads.Outcome
		public var recipient: Recipient
	}

	/// The workspace has no agent with this id, so there is nobody to message.
	public struct AgentNotFound: Error, Equatable {
		public var agentID: String
	}

	/// "About: <subject>": the chat's title, and what finds it again.
	public static func title(about subject: String) -> String { "About: \(subject)" }

	/// The chat to send into: the existing one with this agent about this subject, else a new one
	/// (created empty; the caller sends the first message through the chat store so attachments and
	/// @mentions travel as in Chats). `alsoInvite` are other actors the reader tagged.
	public static func open(
		withAgent agentID: String, titled title: String, alsoInvite: [String] = [],
		conversations: ConversationsStore
	) async throws -> Opened {
		await conversations.loadActors()
		guard let agent = conversations.actors.first(where: {
			$0.id == agentID && $0.participant.kind == .agent
		}) else { throw AgentNotFound(agentID: agentID) }
		await conversations.refresh()
		let recipient = Recipient(
			id: agent.id, name: agent.participant.name,
			isChiefOfStaff: ChiefOfStaffThreads.isChiefOfStaff(agent))
		if let found = conversations.conversations.first(where: {
			isMatch($0, title: title, agent: agent.participant, agentIsChiefOfStaff: recipient.isChiefOfStaff)
		}) {
			return Opened(outcome: .existing(found), recipient: recipient)
		}
		let invited = alsoInvite.filter { $0 != agentID }
		let created = try await conversations.create(
			title: title, participantIDs: [agentID] + invited, firstMessage: nil)
		return Opened(outcome: .created(created), recipient: recipient)
	}

	/// Whether `conversation` is the chat for this agent and subject. Never an archived one.
	/// - The Chief of Staff keeps the rule "About" chats always had (any chat with it under that
	///   title), so existing chats are not lost.
	/// - Any other agent only matches a chat where it is the one agent: an old Chief of Staff chat
	///   that the agent was later tagged into is not taken over, and a different agent gets its own.
	nonisolated static func isMatch(
		_ conversation: ConversationSummary, title: String, agent: ChatParticipant,
		agentIsChiefOfStaff: Bool
	) -> Bool {
		guard conversation.title == title, !conversation.archived,
			conversation.participants.contains(where: { $0.id == agent.id })
		else { return false }
		if agentIsChiefOfStaff { return true }
		return !conversation.participants.contains { $0.kind == .agent && $0.id != agent.id }
	}

	/// The first message's metadata with the agent tagged, so it is woken in a chat of any size.
	public static func tagging(_ agentID: String, in metadata: ChatSendMetadata?) -> ChatSendMetadata {
		var result = metadata ?? ChatSendMetadata()
		var mentions = result.mentions ?? []
		if !mentions.contains(agentID) { mentions.append(agentID) }
		result.mentions = mentions
		return result
	}
}
