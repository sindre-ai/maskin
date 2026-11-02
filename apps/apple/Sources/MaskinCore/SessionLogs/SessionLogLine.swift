import Foundation

/// One log row turned into something a person can read. The CLI writes stream-json envelopes to
/// stdout; the raw JSON is what the web's "Raw" tab shows, this is the readable tab.
public struct SessionLogLine: Identifiable, Equatable, Sendable {
	public enum Kind: Equatable, Sendable { case agent, tool, result, error, system, output }

	/// Unique per line: a row can hold several blocks.
	public var id: String
	public var rowID: Int
	public var kind: Kind
	public var text: String
	public var date: Date?

	public init(rowID: Int, index: Int = 0, kind: Kind, text: String, date: Date? = nil) {
		self.id = "\(rowID)-\(index)"
		self.rowID = rowID
		self.kind = kind
		self.text = text
		self.date = date
	}

	/// The readable lines of one row. Empty for envelopes that carry nothing to read (tool
	/// results, usage events), so they don't clutter the list.
	public static func lines(from row: SessionLogRow) -> [SessionLogLine] {
		let trimmed = row.content.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return [] }
		func line(_ kind: Kind, _ text: String, _ index: Int = 0) -> SessionLogLine {
			SessionLogLine(rowID: row.id, index: index, kind: kind, text: text, date: row.createdAt)
		}
		if row.stream == "stderr" { return [line(.error, trimmed)] }
		if row.stream == "system" { return [line(.system, trimmed)] }
		guard trimmed.hasPrefix("{"), let data = trimmed.data(using: .utf8),
			let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
			let type = object["type"] as? String
		else {
			return [line(.output, trimmed)]
		}
		switch type {
		case "assistant":
			let blocks = (object["message"] as? [String: Any])?["content"] as? [[String: Any]] ?? []
			var out: [SessionLogLine] = []
			for block in blocks {
				switch block["type"] as? String {
				case "text":
					let text = (block["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
					if !text.isEmpty { out.append(line(.agent, text, out.count)) }
				case "tool_use":
					out.append(line(.tool, "Used \(toolName(block["name"] as? String))", out.count))
				default: break
				}
			}
			return out
		case "result":
			let text = (object["result"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
			let failed = object["is_error"] as? Bool ?? false
			if text.isEmpty { return [failed ? line(.error, "The turn failed.") : line(.result, "Turn finished.")] }
			return [line(failed ? .error : .result, text)]
		case "system":
			return (object["subtype"] as? String) == "init" ? [line(.system, "Session started.")] : []
		default:
			return []
		}
	}

	/// `mcp__maskin__get_objects` reads as "get objects"; names without the prefix just lose underscores.
	static func toolName(_ raw: String?) -> String {
		guard var name = raw, !name.isEmpty else { return "a tool" }
		if name.hasPrefix("mcp__"), let last = name.components(separatedBy: "__").last { name = last }
		return name.replacingOccurrences(of: "_", with: " ")
	}
}
