import Foundation

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

	public init(
		id: String = UUID().uuidString, conversationID: String, leadName: String, guests: [String] = [],
		startedAt: Date, endedAt: Date? = nil, spoken: [String] = []
	) {
		self.id = id
		self.conversationID = conversationID
		self.leadName = leadName
		self.guests = guests
		self.startedAt = startedAt
		self.endedAt = endedAt
		self.spoken = spoken
	}
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

/// Which messages of a thread belong to a live call, computed from the call records and the
/// messages' own timestamps: the call's section in the thread, its spoken lines, and the
/// summary card at its end.
public struct LiveCallSpans: Sendable {
	public struct Role: Sendable, Equatable {
		public var record: LiveCallRecord
		public var isFirst: Bool
		public var isLast: Bool
		/// One of your lines that was spoken (not typed during the call).
		public var isSpoken: Bool
	}

	/// By message id.
	public private(set) var roles: [String: Role] = [:]
	/// By record id: the lines of the call in order, for the summary.
	public private(set) var turns: [String: [LiveMeetingTurn]] = [:]

	/// The agent's reply to your last line often lands just after hang-up.
	public static let grace: TimeInterval = 20
	/// Clock difference allowed between this device and the server.
	static let skew: TimeInterval = 5

	public init() {}

	public init(records: [LiveCallRecord], messages: [ChatMessage], currentActorID: String?) {
		for record in records {
			let inside = messages.filter { Self.contains(record, $0) }
			guard !inside.isEmpty else { continue }
			var lines: [LiveMeetingTurn] = []
			for (index, message) in inside.enumerated() {
				let mine = message.actorID == currentActorID
				let spoken =
					mine
					&& (record.spoken.contains(message.content.trimmingCharacters(in: .whitespacesAndNewlines))
						|| message.metadata?["source"]?.stringValue == "live")
				roles[message.id] = Role(
					record: record, isFirst: index == 0, isLast: index == inside.count - 1, isSpoken: spoken)
				lines.append(
					LiveMeetingTurn(
						speaker: mine ? LiveMeetingNote.youName : message.actorName, text: message.content,
						isYou: mine))
			}
			turns[record.id] = lines
		}
	}

	static func contains(_ record: LiveCallRecord, _ message: ChatMessage) -> Bool {
		guard message.kind == "message", !message.isErrorReply, !message.content.isEmpty else { return false }
		guard let created = message.createdAt else { return record.endedAt == nil }
		let end = (record.endedAt ?? .distantFuture)
		let limit = end == .distantFuture ? end : end.addingTimeInterval(grace)
		return created >= record.startedAt.addingTimeInterval(-skew) && created <= limit
	}

	/// The card at the end of a finished call: counts, your first line, the agent's last.
	public func summary(for record: LiveCallRecord) -> LiveMeetingNote? {
		guard let end = record.endedAt else { return nil }
		let title = LiveMeetingFormat.endNote(
			lead: record.leadName, guests: record.guests, seconds: end.timeIntervalSince(record.startedAt))
		return LiveMeetingNote.summary(title: title, turns: turns[record.id] ?? [])
	}
}
