import Foundation

/// What the agent did during a live call, as the server reports it: one chat message per change
/// (`metadata.kind == "receipt"`) and a closing one (`"receipt_summary"`), written by
/// `voice-receipt.ts`. It also sends keys this app ignores (tool, object_type, object_title, more,
/// held, yes_count, card_id, numbers). The messages API types `metadata` as open-ended, so every
/// key reaches `ChatMessage.metadata`. Every field is optional
/// and an unknown `event` reads as `other`, so a newer server never hides a row.
public enum LiveReceiptKind: String, Equatable, Sendable {
	case createdBet = "created_bet"
	case createdTask = "created_task"
	case openedTask = "opened_task"
	case movedToReview = "moved_to_review"
	case decided
	case other

	/// The mono label over the row text.
	public var label: String {
		switch self {
		case .createdBet: "CREATED BET"
		case .createdTask: "CREATED TASK"
		case .openedTask: "OPENED TASK"
		case .movedToReview: "MOVED TO REVIEW"
		case .decided: "DECIDED"
		case .other: "UPDATE"
		}
	}

	/// The object type whose dot colour the row wears; nil for kinds with no object type of their own.
	public var objectType: String? {
		switch self {
		case .createdBet: "bet"
		case .createdTask, .openedTask: "task"
		case .movedToReview, .decided, .other: nil
		}
	}
}

public enum LiveReceiptOutcome: String, Equatable, Sendable {
	case ran
	case failed
	case notDone = "not_done"

	public var didRun: Bool { self == .ran }
}

/// One row in the thread: something the agent did while the call ran.
public struct LiveReceiptEvent: Equatable, Sendable, Identifiable {
	/// The chat message's id.
	public var id: String
	public var callID: String?
	public var kind: LiveReceiptKind
	public var objectID: String?
	public var text: String
	/// Seconds since the call started.
	public var seconds: Int?
	public var outcome: LiveReceiptOutcome

	public init(
		id: String, callID: String? = nil, kind: LiveReceiptKind = .other, objectID: String? = nil,
		text: String, seconds: Int? = nil, outcome: LiveReceiptOutcome = .ran
	) {
		self.id = id
		self.callID = callID
		self.kind = kind
		self.objectID = objectID
		self.text = text
		self.seconds = seconds
		self.outcome = outcome
	}

	/// A decision answered in the call's dock: "Lift the PostHog event cap: approved". The same row
	/// the server's receipt gives, made on this device without waiting for it.
	public static func decided(id: String, seconds: Int, question: String, choice: String) -> LiveReceiptEvent {
		LiveReceiptEvent(id: id, kind: .decided, text: "\(question): \(choice)", seconds: max(0, seconds))
	}

	/// "0:14", "1:02:03"; empty when the server sent no time.
	public var timeLabel: String { seconds.map { LiveMeetingFormat.duration(TimeInterval($0)) } ?? "" }

	/// The label over the text: the kind's, unless the change did not happen.
	public var label: String {
		switch outcome {
		case .ran: kind.label
		case .failed: "FAILED"
		case .notDone: "NOT DONE"
		}
	}
}

/// An object the call created, as a chip on the summary.
public struct LiveCreatedObject: Equatable, Sendable {
	public var type: String
	public var title: String
	public var objectID: String?

	public init(type: String, title: String, objectID: String? = nil) {
		self.type = type
		self.title = title
		self.objectID = objectID
	}
}

/// The card that closes a call: what was decided, what was made, what comes next, and what could
/// not be done. It comes from the server's `receipt_summary` message, or, until that ships, from
/// the call note the app already builds.
public struct LiveCallSummary: Equatable, Sendable, Identifiable {
	public enum Source: Equatable, Sendable { case receipt, note }

	/// The summary message's id, or the call's for one built from the note.
	public var id: String
	public var callID: String?
	public var source: Source
	public var title: String
	public var durationSeconds: Int?
	public var startedAt: Date?
	public var endedAt: Date?
	public var decided: [String]
	public var created: [LiveCreatedObject]
	public var next: [String]
	public var notDone: [String]
	/// Only for a summary built from the note: the last thing the agent said.
	public var closing: String?

	public init(
		id: String, callID: String? = nil, source: Source = .receipt, title: String,
		durationSeconds: Int? = nil, startedAt: Date? = nil, endedAt: Date? = nil, decided: [String] = [],
		created: [LiveCreatedObject] = [], next: [String] = [], notDone: [String] = [], closing: String? = nil
	) {
		self.id = id
		self.callID = callID
		self.source = source
		self.title = title
		self.durationSeconds = durationSeconds
		self.startedAt = startedAt
		self.endedAt = endedAt
		self.decided = decided
		self.created = created
		self.next = next
		self.notDone = notDone
		self.closing = closing
	}

	/// "7:01", "1:00:04"; empty when unknown.
	public var durationLabel: String {
		durationSeconds.map { LiveMeetingFormat.duration(TimeInterval($0)) } ?? ""
	}

	/// True when there is nothing to list, so the card shows only its header and the transcript button.
	public var isBare: Bool {
		decided.isEmpty && created.isEmpty && next.isEmpty && notDone.isEmpty && closing == nil
	}

	/// The summary the app builds itself from a call's note, for a server that sends no receipt.
	public static func fromNote(
		_ note: LiveMeetingNote, id: String, callID: String?, durationSeconds: Int?, startedAt: Date?, endedAt: Date?
	) -> LiveCallSummary {
		LiveCallSummary(
			id: id, callID: callID, source: .note, title: note.heading, durationSeconds: durationSeconds,
			startedAt: startedAt, endedAt: endedAt, closing: note.lastAgentTurn.map { ChatPreviewText.plain($0.text) })
	}
}

/// Reads receipt messages. Kept in one pure place: if the server's shape differs from the contract
/// when it lands, this is the only code that changes.
public enum LiveReceipt {
	public enum Parsed: Equatable, Sendable {
		case event(LiveReceiptEvent)
		case summary(LiveCallSummary)
	}

	public static func parse(_ message: ChatMessage) -> Parsed? {
		guard let meta = message.metadata, let kind = meta["kind"]?.stringValue else { return nil }
		let callID = meta["voice_session_id"]?.stringValue
		switch kind {
		case "receipt":
			let text = meta["text"]?.stringValue.flatMap(nonEmpty) ?? nonEmpty(message.content) ?? ""
			guard !text.isEmpty else { return nil }
			return .event(
				LiveReceiptEvent(
					id: message.id, callID: callID,
					kind: meta["event"]?.stringValue.flatMap(LiveReceiptKind.init(rawValue:)) ?? .other,
					objectID: meta["object_id"]?.stringValue.flatMap(nonEmpty), text: text,
					seconds: meta["t"]?.intValue.map { max(0, $0) },
					outcome: meta["outcome"]?.stringValue.flatMap(LiveReceiptOutcome.init(rawValue:)) ?? .ran))
		case "receipt_summary":
			return .summary(
				LiveCallSummary(
					id: message.id, callID: callID, source: .receipt,
					title: meta["title"]?.stringValue.flatMap(nonEmpty) ?? "",
					durationSeconds: meta["duration_seconds"]?.intValue.map { max(0, $0) },
					endedAt: message.createdAt, decided: strings(meta["decided"]),
					created: (meta["created"]?.arrayValue ?? []).compactMap { item in
						let type = item["type"]?.stringValue ?? ""
						// The server sends an empty title when the object had none.
						let title = item["title"]?.stringValue.flatMap(nonEmpty) ?? (type.isEmpty ? "Untitled" : "New \(type)")
						return LiveCreatedObject(
							type: type, title: title,
							objectID: item["object_id"]?.stringValue.flatMap(nonEmpty))
					}, next: strings(meta["next"]), notDone: strings(meta["not_done"])))
		default:
			return nil
		}
	}

	public static func isReceipt(_ message: ChatMessage) -> Bool { parse(message) != nil }

	private static func strings(_ value: JSONValue?) -> [String] {
		(value?.arrayValue ?? []).compactMap { $0.stringValue.flatMap(nonEmpty) }
	}

	private static func nonEmpty(_ text: String) -> String? {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		return trimmed.isEmpty ? nil : trimmed
	}
}
