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

	/// The line posted into the chat when an ad hoc call ends: "Live meeting with Relay · 0:42", with
	/// anyone who was invited named: "Live meeting with Relay, with Forge and Quill · 0:42".
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
