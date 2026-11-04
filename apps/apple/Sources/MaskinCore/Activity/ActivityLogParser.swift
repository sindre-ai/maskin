import Foundation

/// One `session_logs` row as `GET /api/sessions/{id}/logs` returns it.
public struct SessionLogRow: Equatable, Sendable {
	public var id: Int
	public var stream: String
	public var content: String
	public var createdAt: Date?

	public init(id: Int, stream: String, content: String, createdAt: Date? = nil) {
		self.id = id
		self.stream = stream
		self.content = content
		self.createdAt = createdAt
	}
}

/// Builds per-message turns from a session's raw log rows, the way the web does
/// (`segmentActivityByMessage` in `session-log-transcript.tsx`): the CLI's stream-json envelopes
/// are split at each user envelope tagged with `maskin_message_id`, and every tool call, thought,
/// text block and error after it becomes a step. Beyond the web it also pairs each `tool_use`
/// with its `tool_result` echo, so a step knows whether it is running, done or failed and keeps
/// a short preview of what came back.
public enum ActivityLogParser {
	public static let maxSteps = 100
	public static let maxText = 80
	public static let maxOutput = 300
	public static let maxResultText = 8000

	private struct Builder {
		var turn: ActivityTurn
		var toolIndex: [String: Int] = [:]
		var closed = false
	}

	/// Rows before the first tagged user envelope (the middle of a turn, when the rows are only the
	/// tail of a long session) can't be placed and are dropped.
	public static func turns(from rows: [SessionLogRow], sessionID: String = "") -> [ActivityTurn] {
		var builders: [Builder] = []
		for row in rows {
			if row.stream == "stderr" {
				guard !builders.isEmpty else { continue }
				let text = ToolLabel.shorten(row.content, 100)
				guard !text.isEmpty else { continue }
				append(
					ActivityStep(
						id: "\(row.id)-stderr", kind: .error, label: text, startedAt: row.createdAt,
						finishedAt: row.createdAt, status: .failed), to: &builders[builders.count - 1])
				continue
			}
			guard row.stream == "stdout" else { continue }
			for (index, line) in row.content.split(whereSeparator: \.isNewline).enumerated() {
				guard let data = line.data(using: .utf8),
					let envelope = try? JSONDecoder().decode(JSONValue.self, from: data)
				else { continue }
				handle(envelope, rowID: row.id, index: index, at: row.createdAt, into: &builders)
			}
		}
		return builders.map { finish($0, sessionID: sessionID) }
	}

	// MARK: - Envelopes

	private static func handle(
		_ envelope: JSONValue, rowID: Int, index: Int, at date: Date?, into builders: inout [Builder]
	) {
		switch envelope["type"]?.stringValue {
		case "user":
			if let id = envelope["maskin_message_id"]?.intValue {
				if !builders.isEmpty, builders[builders.count - 1].turn.finishedAt == nil {
					builders[builders.count - 1].turn.finishedAt = date
				}
				builders.append(
					Builder(
						turn: ActivityTurn(
							sessionID: "", messageID: id, startedAt: date, status: .running)))
			} else if !builders.isEmpty {
				attachResults(envelope, at: date, to: &builders[builders.count - 1])
			}
		case "assistant":
			guard !builders.isEmpty, case .array(let blocks)? = envelope["message"]?["content"] else { return }
			for (blockIndex, block) in blocks.enumerated() {
				let stepID = "\(rowID)-\(index)-\(blockIndex)"
				addBlock(block, id: stepID, at: date, to: &builders[builders.count - 1])
			}
		case "result":
			guard !builders.isEmpty else { return }
			let isError = envelope["is_error"]?.boolValue ?? false
			let text = envelope["result"]?.stringValue ?? ""
			var b = builders[builders.count - 1]
			b.turn.result = ActivityResult(
				text: String(text.prefix(maxResultText)), isError: isError, logID: rowID)
			b.turn.status = isError ? .failed : .completed
			b.turn.finishedAt = date
			b.closed = true
			builders[builders.count - 1] = b
		case "error":
			guard !builders.isEmpty else { return }
			let message = envelope["message"]?.stringValue ?? envelope["error"]?.stringValue ?? "Error"
			append(
				ActivityStep(
					id: "\(rowID)-\(index)-error", kind: .error, label: ToolLabel.shorten(message, maxText),
					startedAt: date, finishedAt: date, status: .failed), to: &builders[builders.count - 1])
		default: break
		}
	}

	private static func addBlock(_ block: JSONValue, id: String, at date: Date?, to b: inout Builder) {
		switch block["type"]?.stringValue {
		case "text":
			guard let raw = block["text"]?.stringValue else { return }
			// The wrap-up line after a reply restates the reply step above it.
			if b.turn.steps.last?.category == .reply { return }
			let text = collapse(raw)
			guard !text.isEmpty else { return }
			append(
				ActivityStep(
					id: id, kind: .text, label: ToolLabel.shorten(text, maxText), startedAt: date,
					finishedAt: date), to: &b)
		case "thinking":
			let thought = block["thinking"]?.stringValue ?? block["text"]?.stringValue ?? ""
			let redacted = thought.isEmpty && block["signature"]?.stringValue != nil
			guard !thought.isEmpty || redacted else { return }
			append(
				ActivityStep(
					id: id, kind: .thinking, label: "Thinking…",
					detail: thought.isEmpty ? nil : String(collapse(thought).prefix(ToolLabel.maxDetail)),
					startedAt: date, finishedAt: date), to: &b)
		case "tool_use":
			guard let name = block["name"]?.stringValue else { return }
			let described = ToolLabel.describe(name: name, input: block["input"])
			if described.category == .reply { b.turn.containsReply = true }
			if let toolID = block["id"]?.stringValue { b.toolIndex[toolID] = b.turn.steps.count }
			append(
				ActivityStep(
					id: id, kind: .toolUse, label: described.label, detail: described.detail,
					startedAt: date, status: .running, category: described.category), to: &b)
		default: break
		}
	}

	/// A `user` envelope without a message tag is the CLI echoing tool results back.
	private static func attachResults(_ envelope: JSONValue, at date: Date?, to b: inout Builder) {
		guard case .array(let blocks)? = envelope["message"]?["content"] else { return }
		for block in blocks where block["type"]?.stringValue == "tool_result" {
			guard let toolID = block["tool_use_id"]?.stringValue, let at = b.toolIndex[toolID],
				b.turn.steps.indices.contains(at)
			else { continue }
			let isError = block["is_error"]?.boolValue ?? false
			b.turn.steps[at].status = isError ? .failed : .completed
			b.turn.steps[at].finishedAt = date
			let text = resultText(block["content"])
			if !text.isEmpty { b.turn.steps[at].output = preview(text) }
		}
	}

	// MARK: - Helpers

	private static func append(_ step: ActivityStep, to b: inout Builder) {
		b.turn.steps.append(step)
	}

	/// A tool still without a result is running only while it is the newest step of a turn that
	/// hasn't closed; a step the agent has moved past, or one in a closed turn, is done.
	private static func finish(_ builder: Builder, sessionID: String) -> ActivityTurn {
		var turn = builder.turn
		turn.sessionID = sessionID
		let open = !builder.closed && turn.status == .running
		for i in turn.steps.indices where turn.steps[i].status == .running {
			let isNewest = i == turn.steps.count - 1
			turn.steps[i].status = (open && isNewest) ? .running : (turn.failed ? .failed : .completed)
		}
		if !open, turn.status == .running { turn.status = .completed }
		if turn.steps.count > maxSteps {
			turn.steps = Array(turn.steps.suffix(maxSteps))
			turn.stepsTruncated = true
		}
		return turn
	}

	private static func resultText(_ content: JSONValue?) -> String {
		switch content {
		case .string(let s)?: return s
		case .array(let items)?:
			return items.compactMap { $0["text"]?.stringValue }.joined(separator: "\n")
		default: return ""
		}
	}

	private static func preview(_ text: String) -> String {
		let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
		return t.count <= maxOutput ? t : String(t.prefix(maxOutput - 1)) + "…"
	}

	private static func collapse(_ s: String) -> String {
		s.split(whereSeparator: \.isWhitespace).joined(separator: " ")
	}
}
