import Foundation

/// Decodes the `GET /api/sessions/{id}/activity` body. Tolerant on purpose: a trace is a
/// nicety, so an unknown step kind degrades to plain text and a bad date to nil instead of
/// dropping the whole turn. Only a body that isn't the expected envelope throws.
public enum ActivityParser {
	/// Caps mirror the contract; applied again here so a misbehaving server can't bloat the UI.
	public static let maxSteps = 100
	public static let maxLabel = 120
	public static let maxDetail = 300
	public static let maxResultText = 8000

	public struct ParseError: Error, Equatable, Sendable {}

	public static func parse(_ data: Data) throws -> SessionActivity {
		guard let root = try? JSONDecoder().decode(JSONValue.self, from: data),
			let sessionID = root["session_id"]?.stringValue,
			case .array(let rawTurns)? = root["turns"]
		else { throw ParseError() }
		let turns = rawTurns.compactMap { turn(from: $0, sessionID: sessionID) }
		return SessionActivity(
			sessionID: sessionID, turns: turns, oldestLogID: root["oldest_log_id"]?.intValue,
			hasOlder: root["has_older"]?.boolValue ?? false)
	}

	static func turn(from raw: JSONValue, sessionID: String) -> ActivityTurn? {
		guard let messageID = raw["message_id"]?.intValue else { return nil }
		let rawSteps: [JSONValue]
		if case .array(let items)? = raw["steps"] { rawSteps = items } else { rawSteps = [] }
		let steps = rawSteps.prefix(maxSteps).compactMap(step(from:))
		var result: ActivityResult?
		if let r = raw["result"], let text = r["text"]?.stringValue {
			result = ActivityResult(
				text: String(text.prefix(maxResultText)), isError: r["is_error"]?.boolValue ?? false,
				logID: r["log_id"]?.intValue)
		}
		return ActivityTurn(
			sessionID: sessionID, messageID: messageID,
			startedAt: ChatDates.parse(raw["started_at"]?.stringValue),
			finishedAt: ChatDates.parse(raw["finished_at"]?.stringValue),
			status: status(raw["status"]?.stringValue),
			containsReply: raw["contains_reply"]?.boolValue ?? false, result: result, steps: steps,
			stepsTruncated: raw["steps_truncated"]?.boolValue ?? (rawSteps.count > maxSteps),
			partial: raw["partial"]?.boolValue ?? false)
	}

	static func step(from raw: JSONValue) -> ActivityStep? {
		guard let id = raw["id"]?.stringValue, let label = raw["label"]?.stringValue else { return nil }
		let kind = ActivityStep.Kind(rawValue: raw["kind"]?.stringValue ?? "") ?? .text
		let detail = raw["detail"]?.stringValue.flatMap { $0.isEmpty ? nil : String($0.prefix(maxDetail)) }
		return ActivityStep(
			id: id, kind: kind, label: String(label.prefix(maxLabel)), detail: detail,
			startedAt: ChatDates.parse(raw["started_at"]?.stringValue),
			finishedAt: ChatDates.parse(raw["finished_at"]?.stringValue),
			status: status(raw["status"]?.stringValue))
	}

	private static func status(_ raw: String?) -> ActivityStep.Status {
		ActivityStep.Status(rawValue: raw ?? "") ?? .completed
	}
}
