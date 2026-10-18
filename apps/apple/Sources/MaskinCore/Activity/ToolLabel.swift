import Foundation

/// What kind of work a tool call is; the trace shows it as the short mono word in its label column.
public enum ToolCategory: String, Sendable, Codable, CaseIterable {
	case read, edit, run, search, web, create, reply, delegate, other

	/// The 4-5 letter word in the trace's label column.
	public var word: String {
		switch self {
		case .read: "READ"
		case .edit: "EDIT"
		case .run: "RUN"
		case .search: "FIND"
		case .web: "WEB"
		case .create: "MADE"
		case .reply: "REPLY"
		case .delegate: "TASK"
		case .other: "TOOL"
		}
	}
}

/// A tool call put in human terms: "Read ChatThreadView.swift", "Created task “Fix login”".
public struct ToolDescription: Equatable, Sendable {
	public var label: String
	public var detail: String?
	public var category: ToolCategory
}

/// Maps a raw tool call (`name` + `input`, as the CLI's stream-json carries them) to a label.
/// Claude Code's built-ins first, then the Maskin MCP tools by their verb, then a humanized
/// fallback. Ids (UUIDs) are never shown: a tool whose only argument is an id gets no detail.
public enum ToolLabel {
	public static let maxDetail = 300

	public static func describe(name rawName: String, input: JSONValue?) -> ToolDescription {
		let (server, name) = split(rawName)
		let input = input ?? .null
		func str(_ key: String) -> String? { clean(input[key]?.stringValue) }

		if isReply(name) {
			return .init(label: "Replied to the conversation", detail: nil, category: .reply)
		}
		if server == nil {
			switch name {
			case "Read":
				return file("Read", str("file_path"), .read)
			case "Write":
				return file("Wrote", str("file_path"), .edit)
			case "Edit", "MultiEdit", "NotebookEdit":
				return file("Edited", str("file_path") ?? str("notebook_path"), .edit)
			case "Bash", "BashOutput":
				let command = str("command")
				let label =
					str("description").map { shorten($0) }
					?? command.map { "Ran " + shorten(firstLine($0), 60) } ?? "Ran a command"
				return .init(label: label, detail: command.map { cap($0) }, category: .run)
			case "Grep":
				let q = str("pattern")
				return .init(
					label: q.map { "Searched for “\(shorten($0, 50))”" } ?? "Searched the code",
					detail: str("path") ?? str("glob"), category: .search)
			case "Glob":
				return .init(
					label: str("pattern").map { "Looked for files matching \(shorten($0, 50))" }
						?? "Looked for files",
					detail: str("path"), category: .search)
			case "LS":
				return .init(label: "Listed a folder", detail: str("path"), category: .read)
			case "WebFetch":
				let url = str("url")
				return .init(
					label: url.flatMap(host(of:)).map { "Fetched \($0)" } ?? "Fetched a page", detail: url,
					category: .web)
			case "WebSearch":
				return .init(
					label: str("query").map { "Searched the web for “\(shorten($0, 50))”" }
						?? "Searched the web",
					detail: nil, category: .web)
			case "Task", "Agent":
				return .init(
					label: str("description").map { "Delegated: \(shorten($0, 60))" } ?? "Delegated a task",
					detail: str("prompt").map { cap($0) }, category: .delegate)
			case "ToolSearch":
				return .init(label: "Looked for a tool", detail: str("query"), category: .search)
			case "TodoWrite":
				return .init(label: "Updated the to-do list", detail: nil, category: .other)
			default: break
			}
		}
		if let maskin = maskinTool(name, input) { return maskin }
		return fallback(server: server, name: name, input: input)
	}

	// MARK: - Maskin MCP tools

	private static func maskinTool(_ name: String, _ input: JSONValue) -> ToolDescription? {
		let nodes = objects(in: input)
		let first = nodes.first
		let title = clean(first?["title"]?.stringValue)
		let type = clean(first?["type"]?.stringValue)
		func quoted(_ t: String?) -> String? { t.map { "“\(shorten($0, 50))”" } }
		func what(_ noun: String) -> String {
			if nodes.count > 1 { return "\(nodes.count) \(noun)s" }
			return [type ?? noun, quoted(title)].compactMap { $0 }.joined(separator: " ")
		}
		switch name {
		case "create_objects":
			return .init(label: "Created \(what("object"))", detail: nil, category: .create)
		case "update_objects":
			return .init(label: "Updated \(what("object"))", detail: nil, category: .edit)
		case "delete_object":
			return .init(label: "Deleted an object", detail: nil, category: .edit)
		case "get_objects", "traverse_graph":
			return .init(label: "Looked up objects", detail: nil, category: .read)
		case "list_objects", "list_relationships":
			return .init(label: "Listed objects", detail: nil, category: .read)
		case "search_objects":
			let q = clean(input["query"]?.stringValue)
			return .init(
				label: q.map { "Searched Maskin for “\(shorten($0, 50))”" } ?? "Searched Maskin",
				detail: nil, category: .search)
		case "create_relationship":
			return .init(label: "Linked two objects", detail: nil, category: .create)
		case "create_comment":
			return .init(
				label: "Commented", detail: clean(input["content"]?.stringValue ?? input["text"]?.stringValue)
					.map { cap($0) }, category: .create)
		case "get_comments", "get_events":
			return .init(label: "Read the activity", detail: nil, category: .read)
		case "list_integrations", "list_integration_providers":
			return .init(label: "Checked connected integrations", detail: nil, category: .read)
		case "create_session", "run_agent":
			return .init(label: "Started an agent", detail: nil, category: .delegate)
		case "get_session", "get_session_logs", "list_sessions":
			return .init(label: "Checked an agent run", detail: nil, category: .read)
		case "get_conversation", "list_conversation_messages":
			return .init(label: "Read the conversation", detail: nil, category: .read)
		case "post_conversation_message":
			return .init(label: "Replied to the conversation", detail: nil, category: .reply)
		default: return nil
		}
	}

	/// The array of objects a Maskin write tool carries, under whichever key it uses.
	private static func objects(in input: JSONValue) -> [JSONValue] {
		for key in ["nodes", "objects", "updates", "items"] {
			if case .array(let a)? = input[key] { return a }
		}
		return []
	}

	// MARK: - Fallback

	private static func fallback(server: String?, name: String, input: JSONValue) -> ToolDescription {
		let verb = humanize(name)
		var detail: String?
		if case .object(let o) = input {
			detail = o.keys.sorted().lazy.compactMap { key -> String? in
				guard let v = clean(o[key]?.stringValue), !isIdentifier(v) else { return nil }
				return "\(key): \(v)"
			}.first.map { cap($0) }
		}
		return .init(
			label: "Used \(verb)", detail: detail ?? server.map { "via \(humanize($0))" }, category: .other)
	}

	// MARK: - Helpers

	/// `mcp__maskin__create_objects` -> ("maskin", "create_objects"); a built-in has no server.
	static func split(_ raw: String) -> (server: String?, name: String) {
		guard raw.hasPrefix("mcp__") else { return (nil, raw) }
		let parts = raw.dropFirst(5).components(separatedBy: "__")
		guard parts.count >= 2 else { return (nil, raw) }
		return (parts[0], parts.dropFirst().joined(separator: "__"))
	}

	static func isReply(_ name: String) -> Bool {
		name == "post_conversation_message" || name.hasSuffix("__post_conversation_message")
	}

	private static func file(_ verb: String, _ path: String?, _ category: ToolCategory)
		-> ToolDescription
	{
		guard let path else { return .init(label: "\(verb) a file", detail: nil, category: category) }
		let base = (path as NSString).lastPathComponent
		return .init(label: "\(verb) \(base.isEmpty ? path : base)", detail: path, category: category)
	}

	static func humanize(_ name: String) -> String {
		let words = name.replacingOccurrences(of: "-", with: "_").split(separator: "_").map(String.init)
		return words.joined(separator: " ").lowercased()
	}

	private static func host(of url: String) -> String? {
		URL(string: url)?.host(percentEncoded: false)
	}

	static func isIdentifier(_ s: String) -> Bool {
		UUID(uuidString: s) != nil
	}

	private static func clean(_ s: String?) -> String? {
		guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
		return t
	}

	private static func firstLine(_ s: String) -> String {
		s.split(whereSeparator: \.isNewline).first.map(String.init) ?? s
	}

	/// One line, cut with an ellipsis.
	static func shorten(_ s: String, _ max: Int = 80) -> String {
		let line = firstLine(s).trimmingCharacters(in: .whitespaces)
		return line.count <= max ? line : String(line.prefix(max - 1)) + "…"
	}

	private static func cap(_ s: String) -> String {
		s.count <= maxDetail ? s : String(s.prefix(maxDetail - 1)) + "…"
	}
}
