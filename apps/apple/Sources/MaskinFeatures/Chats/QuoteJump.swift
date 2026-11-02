import MaskinCore

/// Finds the message a quoted reply answers, so a tap on the quote can scroll back to it.
/// A quote is only text (`ChatQuote.make`: name, up to six lines, `…` when cut), so the match is by
/// author and by the quoted words being the start of the original.
enum QuoteJump {
	/// The newest message before `reply` by `quote.author` whose text starts with the quoted words.
	static func original(of quote: QuotedReply, replyID: String, in messages: [ChatMessage]) -> ChatMessage? {
		let wanted = normalise(quote.text.hasSuffix("…") ? String(quote.text.dropLast()) : quote.text)
		guard !wanted.isEmpty else { return nil }
		let earlier = messages.prefix { $0.id != replyID }
		return earlier.last { candidate in
			candidate.actorName == quote.author
				&& normalise(candidate.quotedReply?.body ?? candidate.content).hasPrefix(wanted)
		}
	}

	private static func normalise(_ text: String) -> String {
		text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
	}
}
