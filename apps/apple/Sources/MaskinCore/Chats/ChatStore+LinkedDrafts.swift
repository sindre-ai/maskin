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
	/// mentioning it so it answers. A draft linked by a person has nobody to tell. Returns the
	/// local row id.
	@discardableResult
	public func tellAgentOfSkip(linkedBy actorID: String, author: ChatParticipant.Kind) -> String? {
		send(
			LinkedDraftMessage.skipped,
			metadata: author == .agent ? ChatSendMetadata(mentions: [actorID]) : nil)
	}
}
