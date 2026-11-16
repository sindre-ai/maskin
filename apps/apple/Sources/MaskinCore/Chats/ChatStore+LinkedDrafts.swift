import Foundation

extension ChatStore {
	/// A person approved a draft an agent linked in this chat: tell that agent what was approved,
	/// mentioning it so it answers. The text is quoted exactly as approved. A draft linked by a
	/// person is approved all the same but nobody is mentioned. Returns the local row id.
	@discardableResult
	public func tellAgentOfApproval(
		title: String?, body: String, linkedBy actorID: String, author: ChatParticipant.Kind
	) -> String? {
		send(
			LinkedDraftMessage.approved(title: title, body: body),
			metadata: author == .agent ? ChatSendMetadata(mentions: [actorID]) : nil)
	}

	/// A person skipped a draft an agent linked in this chat: tell that agent not to send it,
	/// mentioning it so it answers. A draft linked by a person has nobody to tell. The message also
	/// carries a declined card answer for the message that holds the draft, so the card still reads
	/// Skipped after a reload (`isDraftSkipped`). Returns the local row id.
	@discardableResult
	public func tellAgentOfSkip(
		linkedBy actorID: String, author: ChatParticipant.Kind, cardMessageID: Int?
	) -> String? {
		send(LinkedDraftMessage.skipped, metadata: Self.skipMetadata(linkedBy: actorID, author: author, cardMessageID: cardMessageID))
	}

	/// What a Skip message carries: the agent it is for, and the card it answers.
	public static func skipMetadata(
		linkedBy actorID: String, author: ChatParticipant.Kind, cardMessageID: Int?
	) -> ChatSendMetadata? {
		let metadata = ChatSendMetadata(
			mentions: author == .agent ? [actorID] : nil,
			cardAnswer: cardMessageID.map { ChatCardAnswer(messageID: $0, outcome: .declined) })
		return metadata.isEmpty ? nil : metadata
	}

	/// True when a person skipped the draft in the message with this id, on any device.
	public func isDraftSkipped(inMessage id: Int) -> Bool {
		allMessages.contains { $0.cardAnswer == ChatCardAnswer(messageID: id, outcome: .declined) }
	}
}
