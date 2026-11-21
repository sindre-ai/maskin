/// When Send must stay off although the shared model would turn it on: a file with no words goes
/// as a chat message or a comment, but not into an edit and not into a message to an agent. The
/// reason shows under the bar, so Send is never off without one.
enum ComposerSendGate {
	static let editNeedsWords = "Add some words to save this edit."
	static let messageNeedsWords = "A file can't go to an agent chat yet. Add some words to send."

	/// - Parameters:
	///   - hasWords: the field holds text.
	///   - hasFiles: the bar holds an attachment. An empty bar shows the mic, so it needs no reason.
	///   - editing: a sent message is open in the bar for an edit (an edit saves text, never files).
	///   - needsWords: set by a host whose send drops files, with its own reason.
	static func blocker(hasWords: Bool, hasFiles: Bool, editing: Bool, needsWords: String?) -> String? {
		guard hasFiles, !hasWords else { return nil }
		if editing { return editNeedsWords }
		return needsWords
	}
}
