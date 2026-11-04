import MaskinCore

/// Finds the message a quoted reply answers, so a tap on the quote can scroll back to it.
/// A quote is only text (`ChatQuote.make`: name, up to six lines, `…` when cut), so the match is by
/// author and by the quoted words being the start of the original.
enum QuoteJump {
	/// The newest message before `reply` by `quote.author` whose text is the quoted words, or starts with them when the quote was cut.
	/// With `quotedID` (the reply's `quoted_message_id`) and that message loaded, it is the answer;
	/// otherwise the text match below.
	static func original(
		of quote: QuotedReply, replyID: String, quotedID: Int? = nil, in messages: [ChatMessage]
	) -> ChatMessage? {
		if let quotedID, let exact = messages.first(where: { $0.serverID == quotedID && $0.id != replyID }) {
			return exact
		}
		let truncated = quote.text.hasSuffix("…")
		let wanted = normalise(truncated ? String(quote.text.dropLast()) : quote.text)
		guard !wanted.isEmpty else { return nil }
		let earlier = messages.prefix { $0.id != replyID }
		return earlier.last { candidate in
			guard candidate.actorName == quote.author else { return false }
			// A quote is built from the whole content, so compare that (a reply's own "> **Kim**"
			// header included). Only a cut quote ("…") may match by prefix.
			let text = normalise(candidate.content)
			return truncated ? text.hasPrefix(wanted) : text == wanted
		}
	}

	private static func normalise(_ text: String) -> String {
		text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
	}
}
