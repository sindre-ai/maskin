import Foundation

/// The grey live words shown while the server transcribes. The phone's recogniser hears each phrase
/// (one task per phrase, cut where the server's phrases are cut) and its words stay on screen until the
/// server's text for that phrase arrives, which replaces them. They never become part of the dictated
/// text on their own: only `text` of the server queue does, or a failed session keeps them (see `Dictation`).
///
/// Phrases are numbered by the order the microphone closes them. The server hands text back in that
/// same order, once per phrase it was sent, so "the n-th delivery" is "the n-th sent phrase". Counting
/// deliveries makes the result independent of whether a delivery or the phrase's close is seen first.
public struct PhrasePreviews: Equatable, Sendable {
	private var texts: [Int: String] = [:]
	/// Phrases that were sent to the server, in order.
	private var sent: [Int] = []
	/// Phrases that were cut without being sent (silence): their words are never shown.
	private var dropped: Set<Int> = []
	private var delivered = 0

	public init() {}

	/// The recogniser's current words for a phrase (the whole phrase so far, not just the new part).
	public mutating func update(phrase: Int, text: String) {
		guard !dropped.contains(phrase) else { return }
		texts[phrase] = text
	}

	/// The microphone closed the phrase. `sent` is false when it was dropped as silence.
	public mutating func close(phrase: Int, sent wasSent: Bool) {
		if wasSent {
			sent.append(phrase)
		} else {
			dropped.insert(phrase)
			texts[phrase] = nil
		}
	}

	/// The server answered for the oldest phrase still waiting (with text or with nothing).
	public mutating func serverDelivered() {
		delivered += 1
	}

	/// What to show in grey: waiting phrases in speaking order, then the phrase still being spoken.
	public var text: String {
		let waiting = sent.dropFirst(delivered)
		let live = texts.keys.filter { !sent.contains($0) }.sorted()
		return (Array(waiting) + live)
			.compactMap { texts[$0]?.trimmingCharacters(in: .whitespacesAndNewlines) }
			.filter { !$0.isEmpty }
			.joined(separator: " ")
	}
}
