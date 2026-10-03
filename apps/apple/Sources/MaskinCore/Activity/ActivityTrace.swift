import Foundation

/// One step of an agent's turn: a tool call, a thinking pause, a text block or an error. The
/// backend normalizes session log envelopes into these (`GET /api/sessions/{id}/activity`), the
/// same shape the web builds in `session-log-transcript.tsx`.
public struct ActivityStep: Identifiable, Equatable, Sendable, Codable {
	public enum Kind: String, Sendable, Codable { case toolUse = "tool_use", thinking, text, error }
	public enum Status: String, Sendable, Codable { case running, completed, failed }

	/// Stable across polls (`<logId>-<blockIndex>`), so a row keeps its identity as it completes.
	public var id: String
	public var kind: Kind
	public var label: String
	public var detail: String?
	public var startedAt: Date?
	public var finishedAt: Date?
	public var status: Status

	public init(
		id: String, kind: Kind, label: String, detail: String? = nil, startedAt: Date? = nil,
		finishedAt: Date? = nil, status: Status = .completed
	) {
		self.id = id
		self.kind = kind
		self.label = label
		self.detail = detail
		self.startedAt = startedAt
		self.finishedAt = finishedAt
		self.status = status
	}

	public var isRunning: Bool { status == .running }
}

/// The agent's closing envelope for a turn.
public struct ActivityResult: Equatable, Sendable, Codable {
	public var text: String
	public var isError: Bool
	public var logID: Int?

	public init(text: String, isError: Bool, logID: Int? = nil) {
		self.text = text
		self.isError = isError
		self.logID = logID
	}
}

/// Everything an agent did for one conversation message.
public struct ActivityTurn: Identifiable, Equatable, Sendable, Codable {
	public var sessionID: String
	/// The conversation message that triggered the turn.
	public var messageID: Int
	public var startedAt: Date?
	public var finishedAt: Date?
	public var status: ActivityStep.Status
	public var containsReply: Bool
	public var result: ActivityResult?
	public var steps: [ActivityStep]
	public var stepsTruncated: Bool

	public var id: String { "\(sessionID)#\(messageID)" }

	public init(
		sessionID: String, messageID: Int, startedAt: Date? = nil, finishedAt: Date? = nil,
		status: ActivityStep.Status = .completed, containsReply: Bool = false,
		result: ActivityResult? = nil, steps: [ActivityStep] = [], stepsTruncated: Bool = false
	) {
		self.sessionID = sessionID
		self.messageID = messageID
		self.startedAt = startedAt
		self.finishedAt = finishedAt
		self.status = status
		self.containsReply = containsReply
		self.result = result
		self.steps = steps
		self.stepsTruncated = stepsTruncated
	}

	public var isRunning: Bool { status == .running }
	public var failed: Bool { status == .failed || result?.isError == true }

	/// The step to emphasize while the turn runs: the one still going, else the newest.
	public var currentStep: ActivityStep? { steps.last(where: \.isRunning) ?? steps.last }

	/// "3 steps · 8s", "Failed after 2 steps", "No steps": the collapsed one-liner for a finished turn.
	public var summary: String {
		let count = steps.count
		let noun = count == 1 ? "1 step" : "\(count) steps"
		if failed { return count == 0 ? "Failed" : "Failed after \(noun)" }
		if count == 0 { return "No steps" }
		if let seconds = duration, seconds >= 1 { return "\(noun) · \(Self.format(seconds))" }
		return noun
	}

	public var duration: TimeInterval? {
		guard let start = startedAt, let end = finishedAt else { return nil }
		return max(end.timeIntervalSince(start), 0)
	}

	public static func format(_ seconds: TimeInterval) -> String {
		let s = Int(seconds.rounded())
		if s < 60 { return "\(s)s" }
		return "\(s / 60)m \(s % 60)s"
	}
}

/// A page of turns for one session, oldest first.
public struct SessionActivity: Equatable, Sendable, Codable {
	public var sessionID: String
	public var turns: [ActivityTurn]
	public var oldestLogID: Int?
	public var hasOlder: Bool

	public init(sessionID: String, turns: [ActivityTurn], oldestLogID: Int? = nil, hasOlder: Bool = false) {
		self.sessionID = sessionID
		self.turns = turns
		self.oldestLogID = oldestLogID
		self.hasOlder = hasOlder
	}
}
