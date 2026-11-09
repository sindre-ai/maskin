import Foundation

/// Which agent questions are answered, and what was picked: the web's `answeredQuestionIds`.
///
/// A question is answered when
/// - any message carries a pick for it (`question_answer`, whoever sent it, a dismissal included), or
/// - this person wrote a normal message after it, in the same place (the main chat, or the same
///   thread). Only their own, confirmed message counts: in a chat with several people someone
///   else typing does not decide for you, and a reply still sending or failed to send has not
///   happened yet. A hidden card nudge, a system line and an agent's message are not replies.
///
/// A helper's question (`reply_to_session`) is only ever answered by a pick.
///
/// Rows compare by server id, so the order of the array never decides anything.
public struct ChatQuestionState: Sendable, Equatable {
	public private(set) var answered: Set<Int> = []
	/// The picks for each answered question. A question closed by typing or dismissed maps to an
	/// empty list (nothing to summarise). When a pick and a typed close both exist, the pick wins.
	public private(set) var answers: [Int: [ChatQuestionAnswer.Answer]] = [:]

	public init(messages: [ChatMessage], viewerID: String) {
		for message in messages {
			guard let id = message.answeredQuestionID else { continue }
			answered.insert(id)
			if answers[id] == nil || answers[id]?.isEmpty == true {
				answers[id] = message.dismissedQuestion ? [] : message.questionAnswers
			}
		}
		// Newest typed reply of this person in each place; nil is the main chat.
		var newestTyped: [Int?: Int] = [:]
		for message in messages where Self.isTypedReply(message, by: viewerID) {
			guard let id = message.serverID else { continue }
			let place = message.threadRootID
			if id > (newestTyped[place] ?? 0) { newestTyped[place] = id }
		}
		for message in messages where !message.questions.isEmpty && !message.isHelperQuestion {
			guard let id = message.serverID, let reply = newestTyped[message.threadRootID], id < reply else {
				continue
			}
			answered.insert(id)
			if answers[id] == nil { answers[id] = [] }
		}
	}

	static func isTypedReply(_ message: ChatMessage, by viewerID: String) -> Bool {
		message.serverID != nil && !message.isFailed
			&& message.author == .human && message.actorID == viewerID
			&& message.kind == "message" && !message.isSystem
			&& !message.isHiddenFromChat && message.answeredQuestionID == nil
	}
}
