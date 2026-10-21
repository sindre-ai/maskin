import Foundation

/// What fills the composer's last slot. The three are mutually exclusive (7-Chat §1): the mic while
/// the field is empty, Send once there is text or an attachment, and Stop while an agent is busy and
/// the field is empty.
public enum ComposerTrailingSlot: Equatable, Sendable {
	case mic, send, stop

	/// - Parameters:
	///   - hasContent: text or at least one attachment.
	///   - isBusy: an agent is typing, streaming or running a live activity.
	///   - canDictate: false where there is no speech recognition (the slot then stays Send, off).
	public static func resolve(hasContent: Bool, isBusy: Bool, canDictate: Bool = true) -> Self {
		if hasContent { return .send }
		if isBusy { return .stop }
		return canDictate ? .mic : .send
	}
}

/// Smart replies (7-Chat §5b): shown when the latest message from someone else ends in a question,
/// the composer is empty and nobody is typing. In production the model could generate them; this is
/// the keyword rule set the design specifies.
public enum QuickReplies {
	public static let shouldI = ["Yes, go ahead", "No, hold off", "Let me check first"]
	public static let canYou = ["Yes, I can", "Not today", "What do you need?"]
	public static let when = ["Today", "Tomorrow morning", "Later this week"]
	public static let other = ["Yes", "No", "Tell me more"]

	/// The chips for `message`, or `[]` when there should be none. A flow ask (a message with
	/// questions) keeps its own recommended-option chips, which take priority.
	public static func options(
		after message: ChatMessage?, currentActorID: String?, composerIsEmpty: Bool, someoneIsTyping: Bool
	) -> [String] {
		guard let message, composerIsEmpty, !someoneIsTyping, message.kind == "message",
			message.actorID != currentActorID, !message.isFailed, !message.isErrorReply,
			message.questions.isEmpty, let question = lastQuestion(in: message.content)
		else { return [] }
		return options(forQuestion: question)
	}

	/// The sentence a message ends on, when it is a question. nil when the message ends in a statement.
	static func lastQuestion(in content: String) -> String? {
		let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
			.trimmingCharacters(in: CharacterSet(charactersIn: "*_`\"')) "))
		guard trimmed.hasSuffix("?") else { return nil }
		// The final sentence: after the last full stop, bang or line break that precedes it.
		let body = trimmed.dropLast()
		let start = body.lastIndex { ".!?\n".contains($0) }.map { body.index(after: $0) } ?? body.startIndex
		let sentence = body[start...].trimmingCharacters(in: .whitespacesAndNewlines)
		return sentence.isEmpty ? nil : sentence
	}

	static func options(forQuestion question: String) -> [String] {
		let q = question.lowercased()
		func starts(_ prefixes: [String]) -> Bool {
			prefixes.contains { q.hasPrefix($0) || q.contains(" \($0)") }
		}
		if starts(["should i", "want me to", "shall i", "do you want me to", "would you like me to"]) {
			return shouldI
		}
		if starts(["can you", "could you", "would you", "will you"]) { return canYou }
		if q.hasPrefix("when") || q.contains(" when ") { return when }
		return other
	}
}

/// Where your latest message stands (7-Chat §3, "Status line"): under that message only.
public enum OutgoingStatus: Equatable, Sendable {
	case sending
	case queued(String)
	case failed(String)
	case sent
	/// Someone replied after it; `by` is the replying agent's name.
	case read(by: String)

	/// The id of the newest message the current actor wrote (what the status line sits under).
	public static func latestOwnID(in messages: [ChatMessage], currentActorID: String?) -> String? {
		guard let currentActorID else { return nil }
		return messages.last { $0.actorID == currentActorID && $0.kind == "message" }?.id
	}

	/// The state of `messageID`, given the thread. Read means an agent has since posted.
	public static func state(of messageID: String, in messages: [ChatMessage], currentActorID: String?)
		-> OutgoingStatus?
	{
		guard let index = messages.firstIndex(where: { $0.id == messageID }) else { return nil }
		let message = messages[index]
		switch message.status {
		case .sending: return .sending
		case .waiting(let reason): return .queued(reason)
		case .failed(let reason): return .failed(reason)
		case .sent: break
		}
		if let reply = messages[(index + 1)...].first(where: {
			$0.author == .agent && $0.actorID != currentActorID && $0.kind == "message"
		}) {
			return .read(by: reply.actorName)
		}
		return .sent
	}

	/// "Sending…", "Sent", "Read by Forge" and, with a clock time, "9:41 AM · Read by Forge".
	public func text(time: String? = nil) -> String {
		let prefix = time.map { "\($0) · " } ?? ""
		switch self {
		case .sending: return "Sending…"
		case .queued(let reason): return "Queued · \(reason)"
		case .failed: return "Not sent · Tap to retry"
		case .sent: return prefix + "Sent"
		case .read(let name): return prefix + "Read by \(name)"
		}
	}
}

/// How the Team list is narrowed by the filter chips (7-Chat §6): All · Unread · People · Agents ·
/// Groups. Off by default; turned on in the Display menu.
public enum ConversationChip: String, CaseIterable, Identifiable, Sendable {
	case all, unread, people, agents, groups

	public var id: String { rawValue }
	public var title: String {
		switch self {
		case .all: "All"
		case .unread: "Unread"
		case .people: "People"
		case .agents: "Agents"
		case .groups: "Groups"
		}
	}

	/// A group is a chat with three or more members, you included.
	public static func isGroup(_ conversation: ConversationSummary, currentActorID: String?) -> Bool {
		conversation.others(excluding: currentActorID).count >= 2
	}

	public func includes(_ conversation: ConversationSummary, currentActorID: String?) -> Bool {
		let others = conversation.others(excluding: currentActorID)
		switch self {
		case .all: return true
		case .unread: return conversation.isUnread
		case .groups: return others.count >= 2
		case .people: return others.count == 1 && others[0].kind == .human
		case .agents: return others.count == 1 && others[0].kind == .agent
		}
	}

	public func apply(to conversations: [ConversationSummary], currentActorID: String?)
		-> [ConversationSummary]
	{
		self == .all ? conversations : conversations.filter { includes($0, currentActorID: currentActorID) }
	}
}

/// The order of the pinned tiles, kept per user: the ids the reader dragged into place. Ids that
/// are no longer pinned drop out; newly pinned ones go at the end in their natural order.
public enum PinnedOrder {
	public static func apply(_ saved: [String], to pinned: [ConversationSummary]) -> [ConversationSummary] {
		let rank = Dictionary(saved.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
		let known = pinned.filter { rank[$0.id] != nil }.sorted { rank[$0.id, default: .max] < rank[$1.id, default: .max] }
		return known + pinned.filter { rank[$0.id] == nil }
	}

	/// Drop `moved` onto `target`: the two swap places (the design's drag-over-a-tile behaviour).
	public static func swap(_ ids: [String], moving moved: String, onto target: String) -> [String] {
		guard moved != target, let a = ids.firstIndex(of: moved), let b = ids.firstIndex(of: target) else {
			return ids
		}
		var result = ids
		result.swapAt(a, b)
		return result
	}
}

/// Persists the pinned order in `UserDefaults` under a key per workspace and actor.
public struct PinnedOrderStore: Sendable {
	private let key: String
	private nonisolated(unsafe) let defaults: UserDefaults

	public init(workspaceID: String, actorID: String, defaults: UserDefaults = .standard) {
		self.key = "chats.pinnedOrder.\(workspaceID).\(actorID)"
		self.defaults = defaults
	}

	public var ids: [String] { defaults.stringArray(forKey: key) ?? [] }
	public func save(_ ids: [String]) { defaults.set(ids, forKey: key) }
}

/// The composer's placeholder (7-Chat §1): always "Message {name}", naming who is on the other side.
public enum ComposerPlaceholder {
	/// "Message Forge", "Message Ida, Forge" and, past two, "Message Ida, Forge +2". People go by
	/// first name, agents by their full name.
	public static func message(to participants: [ChatParticipant], selfID: String?) -> String {
		let others = participants.filter { $0.id != selfID }
		guard !others.isEmpty else { return "Message" }
		let names = others.prefix(2).map { person in
			person.kind == .agent ? person.name : (person.name.split(separator: " ").first.map(String.init) ?? person.name)
		}
		let extra = others.count - names.count
		return "Message " + names.joined(separator: ", ") + (extra > 0 ? " +\(extra)" : "")
	}

	/// While a flow is waiting on an answer from you.
	public static let answering = "Type your answer…"
	public static let dictating = "Listening…"
}

/// The swipe-right-to-reply gesture's numbers (7-Chat §5): the bubble follows the finger at 0.7x,
/// stops at 84pt, ticks past 56pt, and releasing there starts a reply. More than 10pt of vertical
/// travel before the horizontal intent is clear belongs to scrolling.
public enum SwipeReply {
	public static let follow: Double = 0.7
	public static let cap: Double = 84
	public static let threshold: Double = 56
	public static let verticalCancel: Double = 10

	/// How far the bubble moves for a drag of `dx` points (never leftwards).
	public static func offset(forDrag dx: Double) -> Double { min(max(dx, 0) * follow, cap) }

	public static func reachesThreshold(offset: Double) -> Bool { offset >= threshold }

	/// Whether a drag is a reply swipe rather than a scroll: mostly rightwards, within the vertical allowance.
	public static func isReplySwipe(dx: Double, dy: Double) -> Bool {
		dx > 0 && abs(dx) > abs(dy) && abs(dy) <= max(verticalCancel, abs(dx) * 0.5)
	}
}
