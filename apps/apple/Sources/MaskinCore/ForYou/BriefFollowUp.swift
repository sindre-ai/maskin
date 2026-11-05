import Foundation

/// The follow-up chat under every briefing slide: the reader asks the Chief of Staff about the slide
/// on screen and the real agent answers in a real chat. Nothing here invents a reply; this is the
/// wording, the thread naming and the slice of that chat the viewer shows.
public enum BriefFollowUp {
	/// A slide carries no author agent id, only the loop's name, so every slide's follow-up goes to
	/// the one agent every workspace has.
	public static let author = StoryCard.chiefOfStaffUnit

	public static var placeholder: String { "Ask \(author) about this slide" }

	/// The chat a slide's follow-up lives in; the same slide finds the same chat again.
	public static func title(for slide: StoryCard) -> String {
		"About: \(slide.headline.trimmingCharacters(in: .whitespacesAndNewlines))"
	}

	/// The first message of a new chat names the slide, since the agent reads only the text.
	public static func firstMessage(_ text: String, about slide: StoryCard) -> String {
		"Re: \(slide.headline) (from \(slide.unit))\n\n\(text)"
	}

	/// What the reader typed, without the "Re: ..." line `firstMessage` put in front of it.
	public static func displayText(_ content: String) -> String {
		guard content.hasPrefix("Re: "), let gap = content.range(of: "\n\n") else { return content }
		return String(content[gap.upperBound...])
	}

	/// The exchange shown above the composer: the message this panel sent and everything after it.
	/// Earlier history of the same chat stays in the chat ("Continue in chat" opens it).
	public static func exchange(in messages: [ChatMessage], from firstID: String?) -> [ChatMessage] {
		guard let firstID, let start = messages.firstIndex(where: { $0.id == firstID }) else { return [] }
		return Array(messages[start...])
	}

	/// An answer is still owed: nothing from an agent has come after the reader's message yet.
	public static func isAwaitingReply(_ exchange: [ChatMessage]) -> Bool {
		guard let last = exchange.last else { return false }
		return last.author != .agent
	}
}
