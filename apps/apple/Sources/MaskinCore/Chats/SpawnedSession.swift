import Foundation

/// How a handed-off session stands, as the web strip shows it (`lib/handed-off-strip.ts`).
public enum HandoffPill: String, Equatable, Sendable {
	case queued, working, done, failed

	public var label: String {
		switch self {
		case .queued: "Queued"
		case .working: "Working"
		case .done: "Done"
		case .failed: "Failed"
		}
	}
}

/// A sub-agent session another agent started from a message (`spawned_sessions` on a message row
/// of `GET /conversations/{id}/messages`). The server sends no step list: what we know is who, the
/// task, the status, the times and the one-line activity the agent reports while it works.
public struct SpawnedSession: Identifiable, Equatable, Sendable, Codable {
	public var id: String
	/// The server's raw status; `pill` is what the thread shows.
	public var status: String
	public var actorID: String
	public var actorName: String
	public var actionPrompt: String
	public var startedAt: Date?
	public var completedAt: Date?
	public var durationMs: Double?
	/// The note a finished session left (`result.summary`), or why it failed.
	public var outcomeText: String?
	public var currentActivity: String?
	public var dependsOn: [String]

	public init(
		id: String, status: String, actorID: String, actorName: String, actionPrompt: String,
		startedAt: Date? = nil, completedAt: Date? = nil, durationMs: Double? = nil,
		outcomeText: String? = nil, currentActivity: String? = nil, dependsOn: [String] = []
	) {
		self.id = id
		self.status = status
		self.actorID = actorID
		self.actorName = actorName
		self.actionPrompt = actionPrompt
		self.startedAt = startedAt
		self.completedAt = completedAt
		self.durationMs = durationMs
		self.outcomeText = outcomeText
		self.currentActivity = currentActivity
		self.dependsOn = dependsOn
	}

	/// Same mapping as the web: anything the strip has no design for (paused, stopped, unknown
	/// future values) is nil and the row is left out rather than painted with a made-up pill.
	public var pill: HandoffPill? {
		switch status {
		case "pending", "starting": .queued
		case "running": .working
		case "completed": .done
		case "failed", "timeout": .failed
		default: nil
		}
	}

	/// Still has something to report: the thread should keep refreshing while any is live.
	public var isLive: Bool { pill == .queued || pill == .working }

	/// The task in one line: the first non-empty line of the prompt, without markdown heading marks.
	public var title: String {
		let line = actionPrompt.split(whereSeparator: \.isNewline)
			.map { $0.trimmingCharacters(in: .whitespaces) }
			.first { !$0.isEmpty } ?? ""
		let bare = line.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)
		return String(bare.prefix(Self.maxTitleLength))
	}

	static let maxTitleLength = 140

	/// The activity line, only while it works (the server clears it on completion anyway).
	public var liveActivity: String? {
		guard pill == .working, let text = currentActivity?.trimmingCharacters(in: .whitespacesAndNewlines),
			!text.isEmpty
		else { return nil }
		return text
	}

	/// "42s", "3m", "1h 5m": running time while it works (against `now`), the final total once done.
	public func elapsedLabel(now: Date) -> String? {
		switch pill {
		case .working:
			guard let startedAt else { return nil }
			return HandoffDuration.label(seconds: now.timeIntervalSince(startedAt))
		case .done:
			guard let durationMs, durationMs > 0 else { return nil }
			return HandoffDuration.label(seconds: durationMs / 1000)
		default:
			return nil
		}
	}

	/// What a failed row says. Mirrors the web's `failureText`.
	public static let genericFailure = "Stopped before finishing"
}

public enum HandoffDuration {
	public static func label(seconds: TimeInterval) -> String {
		let total = max(0, Int(seconds))
		if total < 60 { return "\(total)s" }
		let minutes = total / 60
		if minutes < 60 { return "\(minutes)m" }
		let rest = minutes % 60
		return rest == 0 ? "\(minutes / 60)h" : "\(minutes / 60)h \(rest)m"
	}
}

extension SpawnedSession {
	/// Reads the session's `result` blob: `summary` for a finished one; `failure_reason` /
	/// `error` / `message` (a plain string, or an object carrying a message) for a failed one.
	static func outcome(from result: JSONValue?, pill: HandoffPill?) -> String? {
		func text(_ value: JSONValue?) -> String? {
			switch value {
			case .string(let s)?: s.isEmpty ? nil : s
			case .object(let o)?: ["message", "reason", "type"].lazy.compactMap { text(o[$0]) }.first
			default: nil
			}
		}
		if case .string(let s)? = result, !s.isEmpty { return pill == .done || pill == .failed ? s : nil }
		guard case .object(let object)? = result else { return pill == .failed ? Self.genericFailure : nil }
		switch pill {
		case .done: return text(object["summary"])
		case .failed:
			return ["failure_reason", "error", "message"].lazy.compactMap { text(object[$0]) }.first
				?? Self.genericFailure
		default: return nil
		}
	}
}
