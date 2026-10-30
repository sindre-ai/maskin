import Foundation

/// One line of a call's transcript: when it was said, by whom, and what.
public struct LiveTranscriptLine: Equatable, Sendable, Identifiable {
	public var id: String
	/// Seconds since the call started.
	public var seconds: Int
	public var speaker: String
	public var text: String
	public var isYou: Bool

	/// "0:14", "1:00:04".
	public var timeLabel: String { LiveMeetingFormat.duration(TimeInterval(seconds)) }
}

/// What "Read transcript" opens: every line saved with a call, in the order it was said. The lines
/// are the chat messages (and the on-device lines of a voice call); the thread does not show them
/// inline, so this is where they are read.
public struct LiveTranscript: Equatable, Sendable {
	public var recordID: String
	public var title: String
	public var lines: [LiveTranscriptLine]
	public var durationSeconds: Int?

	public init(record: LiveCallRecord, messages: [ChatMessage], currentActorID: String?) {
		recordID = record.id
		title = "Live meeting with \(record.leadName)"
		durationSeconds = record.endedAt.map { max(0, Int($0.timeIntervalSince(record.startedAt))) }
		lines = LiveCallCard.merged(messages, with: record, currentActorID: currentActorID)
			.filter { !$0.content.isEmpty }
			.map { message in
				LiveTranscriptLine(
					id: message.id,
					seconds: max(0, Int((message.createdAt ?? record.startedAt).timeIntervalSince(record.startedAt))),
					speaker: message.actorID == currentActorID ? LiveMeetingNote.youName : message.actorName,
					text: ChatPreviewText.plain(message.content), isYou: message.actorID == currentActorID)
			}
	}

	/// "Relay · 7:01" under the title; just the lead while the length is unknown.
	public var subtitle: String {
		guard let durationSeconds else { return "" }
		return LiveMeetingFormat.duration(TimeInterval(durationSeconds))
	}
}

/// Which messages are lines of what was said in a call. A spoken line is tagged `source: voice` and
/// has no `kind`; the agent's receipts, its summary and what it shows on screen (`show`) carry a
/// `kind` and draw in the thread as before. A show message the server has not yet tagged with a
/// kind counts as spoken until that change lands.
public enum LiveSpokenLine {
	public static func isSpoken(_ message: ChatMessage) -> Bool {
		guard let meta = message.metadata, meta["source"]?.stringValue == "voice" else { return false }
		return meta["kind"] == nil
	}

	/// Whether the thread may leave a call's spoken lines out: only when it holds what stands in for
	/// them. That is any receipt or closing receipt posted for this call, or, for a call that has
	/// ended, the summary the app builds itself from the call note (which `fallbackSummary` yields
	/// exactly when the call ended with something said). A call with neither keeps its folded
	/// transcript card, so it never shows nothing.
	public static func hidesSpokenLines(
		for record: LiveCallRecord, in messages: [ChatMessage], currentActorID: String?
	) -> Bool {
		if messages.contains(where: { LiveReceipt.isReceipt($0) && LiveCallWindow.closes(record, $0) }) { return true }
		guard record.endedAt != nil else { return false }
		let spoken = messages.filter {
			LiveCallWindow.contains(record, $0, currentActorID: currentActorID, spokenOnly: true)
		}
		return LiveCallWindow.fallbackSummary(for: record, messages: spoken, currentActorID: currentActorID) != nil
	}
}
