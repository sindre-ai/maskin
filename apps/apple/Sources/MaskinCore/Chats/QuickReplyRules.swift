import Foundation

/// Quick replies (spec 7 §5b): one-tap answers offered under the composer when the latest message
/// from someone else ends in a question. Pure rules so the chips can be tested without a view. In
/// production the model is meant to generate these; until that lands the prototype's keyword rules
/// pick a set by intent.
public enum QuickReplyRules {
	/// What kind of question was asked; each has its own set of replies.
	public enum Intent: Equatable, Sendable {
		/// "Should I…", "Want me to…", "Shall I…": asking for permission.
		case permission
		/// "Can you…", "Could you…", "Would you…": asking whether the reader can do something.
		case capability
		/// "When…": asking for a time.
		case timing
		/// Any other question.
		case general
	}

	public static func replies(for intent: Intent) -> [String] {
		switch intent {
		case .permission: ["Yes, go ahead", "No, hold off", "Let me check first"]
		case .capability: ["Yes, I can", "Not today", "What do you need?"]
		case .timing: ["Today", "Tomorrow morning", "Later this week"]
		case .general: ["Yes", "No", "Tell me more"]
		}
	}

	/// The replies for a message, or an empty list for a statement.
	public static func replies(for text: String) -> [String] {
		intent(of: text).map(replies(for:)) ?? []
	}

	/// Nil for a statement: only text whose last sentence ends in a question mark counts. The
	/// question is matched on its own words so an earlier statement doesn't change the intent.
	public static func intent(of text: String) -> Intent? {
		guard let question = lastQuestion(in: text) else { return nil }
		let words = " " + question.lowercased() + " "
		if ["should i", "shall i", "want me to", "do you want me to", "ok if i", "may i"]
			.contains(where: { words.contains(" \($0) ") })
		{
			return .permission
		}
		if ["can you", "could you", "would you", "will you", "are you able to"]
			.contains(where: { words.contains(" \($0) ") })
		{
			return .capability
		}
		if words.hasPrefix(" when ") || words.contains(" by when ") || words.contains(" what time ")
			|| words.contains(" what day ")
		{
			return .timing
		}
		return .general
	}

	/// The final sentence of `text` when it ends in "?", stripped of closing quotes and brackets.
	static func lastQuestion(in text: String) -> String? {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
			.trimmingCharacters(in: CharacterSet(charactersIn: "\"'”’)*_]"))
		guard trimmed.hasSuffix("?") else { return nil }
		// Back to the previous sentence end or line break.
		let body = trimmed.dropLast()
		let breakers: Set<Character> = [".", "!", "?", "\n"]
		let start = body.lastIndex(where: { breakers.contains($0) }).map { body.index(after: $0) } ?? body.startIndex
		let question = body[start...].trimmingCharacters(in: .whitespacesAndNewlines)
		return question.isEmpty ? nil : question
	}

	/// The chips to show for a thread: only when the newest message is from someone else, ends in
	/// a question, carries no flow ask of its own (its recommended options take priority), the
	/// composer is empty and nobody is typing.
	public static func suggestions(
		latest: ChatMessage?, currentActorID: String, composerEmpty: Bool, somebodyTyping: Bool
	) -> [String] {
		guard composerEmpty, !somebodyTyping, let latest, !latest.isSystem, latest.kind == "message",
			latest.actorID != currentActorID, latest.questions.isEmpty, !latest.isErrorReply
		else { return [] }
		return replies(for: latest.content)
	}
}
