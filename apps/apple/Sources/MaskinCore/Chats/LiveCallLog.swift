import Foundation

/// One spoken turn of a voice call, kept with the call on this device. A voice call has no chat
/// messages of its own, so these are what its card shows.
public struct LiveCallLine: Codable, Equatable, Sendable {
	public var isYou: Bool
	public var text: String
	public var at: Date

	public init(isYou: Bool, text: String, at: Date) {
		self.isYou = isYou
		self.text = text
		self.at = at
	}
}

/// One live call, remembered on this device so the thread can show it: where it was, who it was
/// with, when it started and ended, and which of your lines were spoken rather than typed.
///
/// Nothing is posted to the chat for a call's start or end (a user-authored note would read as
/// something you said and make the agent answer it). The thread derives the call from the
/// messages inside its time window instead, so the record is only a window and a few labels.
public struct LiveCallRecord: Codable, Equatable, Sendable, Identifiable {
	public var id: String
	public var conversationID: String
	public var leadName: String
	public var guests: [String]
	public var startedAt: Date
	public var endedAt: Date?
	/// The text of each line that was sent by voice, in order.
	public var spoken: [String]
	/// Both sides of a voice call, as they were transcribed. Empty for a dictated call, whose lines
	/// are real chat messages.
	public var lines: [LiveCallLine]
	/// Whether the person left the call's card open or closed; nil takes the default (open while
	/// the call runs, closed once it has ended).
	public var expanded: Bool?

	public init(
		id: String = UUID().uuidString, conversationID: String, leadName: String, guests: [String] = [],
		startedAt: Date, endedAt: Date? = nil, spoken: [String] = [], lines: [LiveCallLine] = [],
		expanded: Bool? = nil
	) {
		self.id = id
		self.conversationID = conversationID
		self.leadName = leadName
		self.guests = guests
		self.startedAt = startedAt
		self.endedAt = endedAt
		self.spoken = spoken
		self.lines = lines
		self.expanded = expanded
	}

	/// Calls saved before voice calls kept their lines have no `lines` key.
	public init(from decoder: Decoder) throws {
		let c = try decoder.container(keyedBy: CodingKeys.self)
		id = try c.decode(String.self, forKey: .id)
		conversationID = try c.decode(String.self, forKey: .conversationID)
		leadName = try c.decode(String.self, forKey: .leadName)
		guests = try c.decode([String].self, forKey: .guests)
		startedAt = try c.decode(Date.self, forKey: .startedAt)
		endedAt = try c.decodeIfPresent(Date.self, forKey: .endedAt)
		spoken = try c.decode([String].self, forKey: .spoken)
		lines = try c.decodeIfPresent([LiveCallLine].self, forKey: .lines) ?? []
		expanded = try c.decodeIfPresent(Bool.self, forKey: .expanded)
	}

	/// The thread shows a card for a call once it has ended or has something in it; a running call
	/// with nothing said yet shows the call's empty state instead.
	public var showsCard: Bool { endedAt != nil || !lines.isEmpty }
}

/// The device's list of recent live calls (newest kept, the oldest dropped past `limit`).
@MainActor
public struct LiveCallLog {
	public static let shared = LiveCallLog()
	static let limit = 60
	private let defaults: UserDefaults
	private let key = "live.calls.v1"

	public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

	public func all() -> [LiveCallRecord] {
		guard let data = defaults.data(forKey: key) else { return [] }
		return (try? JSONDecoder().decode([LiveCallRecord].self, from: data)) ?? []
	}

	public func records(for conversationID: String) -> [LiveCallRecord] {
		all().filter { $0.conversationID == conversationID }
	}

	public func save(_ record: LiveCallRecord) {
		var list = all()
		if let index = list.firstIndex(where: { $0.id == record.id }) { list[index] = record } else { list.append(record) }
		if list.count > Self.limit { list.removeFirst(list.count - Self.limit) }
		if let data = try? JSONEncoder().encode(list) { defaults.set(data, forKey: key) }
	}

	public func update(_ id: String, _ change: (inout LiveCallRecord) -> Void) {
		guard var record = all().first(where: { $0.id == id }) else { return }
		change(&record)
		save(record)
	}
}

/// The part of a thread a live call folds away: the messages in its time window, as one card.
public enum LiveCallWindow {
	/// The agent's reply to your last line often lands just after hang-up.
	public static let grace: TimeInterval = 20
	/// Clock difference allowed between this device and the server.
	static let skew: TimeInterval = 5

	/// Whether `message` is part of the call: in its window, and said by you or an agent. Another
	/// person posting meanwhile in a group chat stays in the thread, outside the card.
	public static func contains(_ record: LiveCallRecord, _ message: ChatMessage, currentActorID: String?) -> Bool {
		guard message.kind == "message", !message.isErrorReply, !message.content.isEmpty else { return false }
		guard message.actorID == currentActorID || message.author == .agent else { return false }
		guard let created = message.createdAt else { return record.endedAt == nil }
		let end = record.endedAt.map { $0.addingTimeInterval(grace) } ?? .distantFuture
		return created >= record.startedAt.addingTimeInterval(-skew) && created <= end
	}
}

/// One live call as the thread shows it: a single foldable card holding every line of the call.
public struct LiveCallCard: Equatable, Sendable, Identifiable {
	public var record: LiveCallRecord
	/// The call's messages in order (they are still ordinary chat messages; only the layout folds them).
	public var messages: [ChatMessage]
	public var currentActorID: String?

	public var id: String { "call-\(record.id)" }
	public var isActive: Bool { record.endedAt == nil }
	/// Open while the call runs unless the person closed it; closed after, unless they opened it.
	public var startsExpanded: Bool { isActive ? (record.expanded ?? true) : (record.expanded ?? false) }

	public init(record: LiveCallRecord, messages: [ChatMessage], currentActorID: String?) {
		self.record = record
		self.messages = Self.merged(messages, with: record, currentActorID: currentActorID)
		self.currentActorID = currentActorID
	}

	/// The call's chat messages plus the lines a voice call kept, in the order they were said. The
	/// lines become messages from you and from the lead agent so the card draws them like any other.
	static func merged(_ messages: [ChatMessage], with record: LiveCallRecord, currentActorID: String?) -> [ChatMessage] {
		guard !record.lines.isEmpty else { return messages }
		let spoken = record.lines.enumerated().map { index, line in
			ChatMessage(
				id: "live-\(record.id)-\(index)", conversationID: record.conversationID,
				actorID: line.isYou ? (currentActorID ?? "you") : "live-\(record.id)-agent",
				actorName: line.isYou ? LiveMeetingNote.youName : record.leadName,
				author: line.isYou ? .human : .agent, content: line.text, createdAt: line.at)
		}
		return (messages + spoken).enumerated()
			.sorted { a, b in
				let (x, y) = (a.element.createdAt ?? .distantFuture, b.element.createdAt ?? .distantFuture)
				return x == y ? a.offset < b.offset : x < y
			}
			.map(\.element)
	}

	public func isYou(_ message: ChatMessage) -> Bool { message.actorID == currentActorID }
	public var youCount: Int { messages.filter(isYou).count }
	public var replyCount: Int { messages.count - youCount }

	/// "Live call with Relay", naming anyone who was invited: "Live call with Relay, with Forge".
	public var title: String {
		var text = "Live call with \(record.leadName)"
		if !record.guests.isEmpty { text += ", with \(LiveMeetingFormat.list(record.guests))" }
		return text
	}

	/// How long the call ran ("7:01"), or has run so far.
	public func durationText(now: Date) -> String {
		LiveMeetingFormat.duration((record.endedAt ?? now).timeIntervalSince(record.startedAt))
	}

	/// "4 from you · 3 replies"; empty text for a call nobody spoke in.
	public var counts: String {
		guard !messages.isEmpty else { return "" }
		let you = youCount == 1 ? "1 from you" : "\(youCount) from you"
		let other = replyCount == 1 ? "1 reply" : "\(replyCount) replies"
		return "\(you) · \(other)"
	}

	/// The newest line, flattened, for the collapsed card.
	public var preview: String? {
		guard let last = messages.last else { return nil }
		let text = ChatPreviewText.plain(last.content)
		return (isYou(last) ? "You: " : "\(last.actorName): ") + text
	}

	/// Objects the call has linked, newest first.
	public var mentioned: [MentionedObject] { CallMentions.objects(in: messages) }
}
