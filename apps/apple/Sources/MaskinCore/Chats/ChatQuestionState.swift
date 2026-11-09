import Foundation

/// Which agent questions are answered, and what was picked: the web's `answeredQuestionIds`.
///
/// A question is answered when
/// - any message carries a usable pick for it (`question_answer` with at least one chosen option,
///   whoever sent it, a dismissal included; an empty or malformed one answers nothing), or
/// - this person wrote a normal message after it, in the same place (the main chat, or the same
///   thread), and it is the newest question still open at that moment: one reply closes one card,
///   so with Q1 then Q2 asked and Q2 answered, Q1 stays open. Only their own, confirmed message
///   counts: in a chat with several people someone else typing does not decide for you, and a
///   reply still sending or failed to send has not happened yet. A hidden card nudge, a system
///   line and an agent's message are not replies.
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
			guard let id = message.usableAnsweredQuestionID else { continue }
			answered.insert(id)
			if answers[id] == nil || answers[id]?.isEmpty == true {
				answers[id] = message.dismissedQuestion ? [] : message.questionAnswers
			}
		}
		var replies: [(id: Int, place: Int?)] = []
		var questions: [(id: Int, place: Int?)] = []
		for message in messages {
			guard let id = message.serverID else { continue }
			if !message.questions.isEmpty {
				if !message.isHelperQuestion { questions.append((id, message.threadRootID)) }
			} else if Self.isTypedReply(message, by: viewerID) {
				replies.append((id, message.threadRootID))
			}
		}
		// Oldest reply first, each closing the newest question in its place that is still open.
		for reply in replies.sorted(by: { $0.id < $1.id }) {
			let target =
				questions
				.filter { $0.place == reply.place && $0.id < reply.id && !answered.contains($0.id) }
				.map(\.id).max()
			guard let target else { continue }
			answered.insert(target)
			if answers[target] == nil { answers[target] = [] }
		}
	}

	static func isTypedReply(_ message: ChatMessage, by viewerID: String) -> Bool {
		message.serverID != nil && !message.isFailed
			&& message.author == .human && message.actorID == viewerID
			&& message.kind == "message" && !message.isSystem
			&& !message.isHiddenFromChat && message.answeredQuestionID == nil
	}
}
