import Foundation

/// What kind of live call is open: an ad hoc call with the agent of a chat, or the daily briefing
/// the For you tab starts with the Chief of Staff.
public enum LiveMeetingKind: Equatable, Sendable {
	case adHoc, dailyBriefing

	/// The mono label over the avatar.
	public var label: String {
		switch self {
		case .adHoc: "LIVE · AD HOC MEETING"
		case .dailyBriefing: "LIVE · DAILY BRIEFING"
		}
	}

	/// An ad hoc call leaves a line in its chat when it ends; the briefing just closes.
	public var postsNote: Bool { self == .adHoc }
}

/// Wording and timing for a live call, kept apart from the screen so it can be tested.
public enum LiveMeetingFormat {
	/// "0:42", "12:05", "1:02:03".
	public static func duration(_ seconds: TimeInterval) -> String {
		let total = max(0, Int(seconds))
		let hours = total / 3600
		let minutes = total % 3600 / 60
		let secs = total % 60
		return hours > 0
			? String(format: "%d:%02d:%02d", hours, minutes, secs)
			: String(format: "%d:%02d", minutes, secs)
	}

	/// The first line of the note posted when an ad hoc call ends: "Live meeting with Relay · 0:42",
	/// with anyone who was invited named: "Live meeting with Relay, with Forge and Quill · 0:42".
	public static func endNote(lead: String, guests: [String], seconds: TimeInterval) -> String {
		var text = "Live meeting with \(lead)"
		if !guests.isEmpty { text += ", with \(list(guests))" }
		return "\(text) · \(duration(seconds))"
	}

	/// "A", "A and B", "A, B and C".
	static func list(_ names: [String]) -> String {
		switch names.count {
		case 0: ""
		case 1: names[0]
		default: names.dropLast().joined(separator: ", ") + " and " + names[names.count - 1]
		}
	}
}

/// Who is on the "To" line of a new conversation, and what Send will create.
public struct NewConversationDraft: Equatable, Sendable {
	/// Chosen actor ids, in the order they were picked.
	public private(set) var recipientIDs: [String] = []
	private var defaulted = false

	public init() {}

	/// More than one recipient makes a group chat.
	public var isGroup: Bool { recipientIDs.count > 1 }

	/// Puts the Chief of Staff on the line, once, when the actors arrive. A person who removed it
	/// is not given it back.
	public mutating func applyDefault(actors: [ChatActor], excluding selfID: String?) {
		guard !defaulted, !actors.isEmpty else { return }
		defaulted = true
		if recipientIDs.isEmpty,
			let chief = actors.first(where: { $0.isChiefOfStaff && $0.id != selfID })
		{
			recipientIDs = [chief.id]
		}
	}

	public mutating func toggle(_ id: String) {
		defaulted = true
		if let index = recipientIDs.firstIndex(of: id) { recipientIDs.remove(at: index) } else { recipientIDs.append(id) }
	}

	public mutating func remove(_ id: String) {
		defaulted = true
		recipientIDs.removeAll { $0 == id }
	}

	/// Actors still offered under "Add someone": not you, not already chosen.
	public func addable(from actors: [ChatActor], excluding selfID: String?) -> [ChatActor] {
		actors.filter { $0.id != selfID && !recipientIDs.contains($0.id) }
			.sorted {
				($0.isChiefOfStaff ? 0 : 1, $0.participant.kind == .agent ? 0 : 1, $0.participant.name)
					< ($1.isChiefOfStaff ? 0 : 1, $1.participant.kind == .agent ? 0 : 1, $1.participant.name)
			}
	}
}

extension ChatActor {
	/// The workspace's own Chief of Staff agent.
	public var isChiefOfStaff: Bool {
		isSystem && participant.kind == .agent && participant.name == "Chief of Staff"
	}
}

/// Which existing chat a Live call with the Chief of Staff, started from the Chats list, belongs in.
public enum ChiefOfStaffLiveChat {
	/// The newest live one-to-one chat with the Chief of Staff, leaving out the daily briefing's own
	/// chat. Nil when there is none, and the caller creates one.
	public static func pick(
		from conversations: [ConversationSummary], chiefID: String, excludingTitle: String
	) -> ConversationSummary? {
		conversations
			.filter {
				!$0.archived && $0.title != excludingTitle && $0.participants.count <= 2
					&& $0.participants.contains { $0.id == chiefID }
			}
			.max { ($0.lastMessageAt ?? .distantPast) < ($1.lastMessageAt ?? .distantPast) }
	}
}


/// One thing said in a live call: what you said, or what the agent answered.
public struct LiveMeetingTurn: Equatable, Sendable {
	public var speaker: String
	public var text: String
	public var isYou: Bool

	public init(speaker: String, text: String, isYou: Bool) {
		self.speaker = speaker
		self.text = text
		self.isYou = isYou
	}
}

/// The note an ad hoc call leaves in its chat when it ends: a header line, then the transcript (or
/// an honest "No speech was captured"). It is plain markdown, so the agent reads the call as
/// context and any client that does not know the format still shows something readable; this
/// type also reads it back so the thread can draw it as a summary card.
public struct LiveMeetingNote: Equatable, Sendable {
	public var title: String
	public var turns: [LiveMeetingTurn]

	public static let transcriptHeading = "**Transcript**"
	public static let emptyText = "No speech was captured."
	static let maxTurnLength = 1200
	static let maxTranscriptLength = 12_000
	public static let youName = "You"

	public init(title: String, turns: [LiveMeetingTurn]) {
		self.title = title
		self.turns = turns
	}

	/// The markdown posted into the chat. Turns are flattened to one line each and the whole
	/// transcript is capped, keeping the most recent lines.
	public var markdown: String {
		guard !turns.isEmpty else { return "\(title)\n\n\(Self.emptyText)" }
		var lines = turns.map { turn in
			"- **\(turn.isYou ? Self.youName : Self.clean(turn.speaker)):** \(Self.shorten(turn.text))"
		}
		var dropped = 0
		while lines.joined(separator: "\n").count > Self.maxTranscriptLength, lines.count > 1 {
			lines.removeFirst()
			dropped += 1
		}
		let earlier = dropped > 0 ? "\n_\(dropped) earlier lines left out._" : ""
		return "\(title)\n\n\(Self.transcriptHeading)\(earlier)\n" + lines.joined(separator: "\n")
	}

	/// Reads a message back as a call note; nil for any other message.
	public static func parse(_ content: String) -> LiveMeetingNote? {
		guard content.hasPrefix("Live meeting with ") else { return nil }
		let lines = content.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
		guard let title = lines.first, title.contains(" · "),
			lines.contains(transcriptHeading) || lines.contains(emptyText)
		else { return nil }
		var turns: [LiveMeetingTurn] = []
		for line in lines.dropFirst() where line.hasPrefix("- **") {
			let body = line.dropFirst(4)
			guard let split = body.range(of: ":** ") else { continue }
			let speaker = String(body[body.startIndex..<split.lowerBound])
			let text = String(body[split.upperBound...])
			turns.append(LiveMeetingTurn(speaker: speaker, text: text, isYou: speaker == youName))
		}
		return LiveMeetingNote(title: title, turns: turns)
	}

	/// The duration at the end of the title ("7:01"), as shown on the card.
	public var durationText: String {
		title.components(separatedBy: " · ").last ?? ""
	}

	/// The title without its duration: "Live meeting with Relay".
	public var heading: String {
		var parts = title.components(separatedBy: " · ")
		if parts.count > 1 { parts.removeLast() }
		return parts.joined(separator: " · ")
	}

	public var youCount: Int { turns.filter(\.isYou).count }
	public var agentCount: Int { turns.count - youCount }

	/// The last thing the agent said, the nearest thing to an outcome the transcript has.
	public var lastAgentTurn: LiveMeetingTurn? { turns.last { !$0.isYou } }
	public var firstYouTurn: LiveMeetingTurn? { turns.first { $0.isYou } }

	private static func clean(_ text: String) -> String {
		text.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "\n", with: " ")
	}

	private static func shorten(_ text: String) -> String {
		let flat = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
			.filter { !$0.isEmpty }.joined(separator: " ")
		guard flat.count > maxTurnLength else { return flat }
		return String(flat.prefix(maxTurnLength)).trimmingCharacters(in: .whitespaces) + "…"
	}
}
