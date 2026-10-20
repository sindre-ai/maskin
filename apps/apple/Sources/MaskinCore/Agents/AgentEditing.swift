import Foundation

/// The fields an edit changes. Only what differs from the profile is sent, so saving a new name
/// never rewrites the instructions someone else just changed.
public struct AgentEdit: Equatable, Sendable {
	public var name: String?
	public var description: String?
	public var systemPrompt: String?
	public var tools: [AgentTool]?

	public init(
		name: String? = nil, description: String? = nil, systemPrompt: String? = nil,
		tools: [AgentTool]? = nil
	) {
		self.name = name
		self.description = description
		self.systemPrompt = systemPrompt
		self.tools = tools
	}

	public var isEmpty: Bool {
		name == nil && description == nil && systemPrompt == nil && tools == nil
	}

	/// Applies the edit to a profile, for the optimistic update.
	func applied(to profile: AgentProfile) -> AgentProfile {
		var next = profile
		if let name { next.name = name }
		if let description { next.description = description.isEmpty ? nil : description }
		if let systemPrompt { next.systemPrompt = systemPrompt }
		if let tools { next.tools = tools }
		return next
	}
}

/// What the create and edit sheets bind to. Pure value logic, so it tests without a view.
public struct AgentDraft: Equatable, Sendable {
	public static let descriptionLimit = 2000

	public var name: String
	public var description: String
	public var systemPrompt: String

	public init(name: String = "", description: String = "", systemPrompt: String = "") {
		self.name = name
		self.description = description
		self.systemPrompt = systemPrompt
	}

	public init(profile: AgentProfile) {
		self.init(
			name: profile.name, description: profile.description ?? "",
			systemPrompt: profile.systemPrompt ?? "")
	}

	public var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
	public var trimmedDescription: String {
		description.trimmingCharacters(in: .whitespacesAndNewlines)
	}

	public var isValid: Bool {
		!trimmedName.isEmpty && trimmedDescription.count <= Self.descriptionLimit
	}

	/// The changed fields against `profile`, or nil when nothing changed (or the draft is
	/// invalid, e.g. an emptied name).
	public func edit(against profile: AgentProfile) -> AgentEdit? {
		guard isValid else { return nil }
		var edit = AgentEdit()
		if trimmedName != profile.name { edit.name = trimmedName }
		if trimmedDescription != (profile.description ?? "") { edit.description = trimmedDescription }
		if systemPrompt != (profile.systemPrompt ?? "") { edit.systemPrompt = systemPrompt }
		return edit.isEmpty ? nil : edit
	}
}

/// A new MCP server being added to an agent: a custom URL or command.
public struct MCPServerDraft: Equatable, Sendable {
	public enum Kind: String, CaseIterable, Sendable { case http, stdio }

	public var kind: Kind
	public var name: String
	public var url: String
	public var command: String
	public var args: String

	public init(
		kind: Kind = .http, name: String = "", url: String = "", command: String = "", args: String = ""
	) {
		self.kind = kind
		self.name = name
		self.url = url
		self.command = command
		self.args = args
	}

	/// Server keys end up in config and env names: letters, digits, `-` and `_` only.
	public static func sanitize(_ raw: String) -> String {
		let mapped = raw.trimmingCharacters(in: .whitespaces).lowercased().map { char -> Character in
			(char.isASCII && (char.isLetter || char.isNumber)) || char == "-" || char == "_" ? char : "-"
		}
		return String(mapped).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
	}

	/// Splits an argument line on whitespace, keeping "double quoted" runs together.
	public static func splitArgs(_ line: String) -> [String] {
		var out: [String] = []
		var current = ""
		var quoted = false
		var started = false
		for char in line {
			if char == "\"" {
				quoted.toggle()
				started = true
			} else if char.isWhitespace && !quoted {
				if started { out.append(current) }
				current = ""
				started = false
			} else {
				current.append(char)
				started = true
			}
		}
		if started { out.append(current) }
		return out
	}

	/// The tool this draft describes, or why it can't be added yet. `existing` guards against
	/// silently overwriting a server of the same name.
	public func build(existing: [AgentTool]) -> Result<AgentTool, AgentsError> {
		let key = Self.sanitize(name)
		if key.isEmpty { return .failure(AgentsError("Give the server a name.")) }
		if existing.contains(where: { $0.name == key }) {
			return .failure(AgentsError("There's already a server called \(key)."))
		}
		switch kind {
		case .http:
			let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
			guard let parsed = URL(string: trimmed), let scheme = parsed.scheme?.lowercased(),
				scheme == "https" || scheme == "http", parsed.host?.isEmpty == false
			else { return .failure(AgentsError("Enter a full URL starting with https://.")) }
			return .success(
				AgentTool(
					name: key, kind: "http",
					spec: .object(["type": .string("http"), "url": .string(trimmed)])))
		case .stdio:
			let cmd = command.trimmingCharacters(in: .whitespacesAndNewlines)
			if cmd.isEmpty { return .failure(AgentsError("Enter the command to start the server.")) }
			let argv = Self.splitArgs(args)
			return .success(
				AgentTool(
					name: key, kind: "stdio",
					spec: .object([
						"type": .string("stdio"), "command": .string(cmd),
						"args": .array(argv.map { .string($0) }),
					])))
		}
	}
}

/// One-tap servers for the common cases. Specs mirror the web's quick-add presets: `${…}` values
/// are placeholders the session fills in at run time (the Maskin API key, each provider's OAuth
/// token), so no secret is ever stored in the agent.
public struct MCPPreset: Identifiable, Equatable, Sendable {
	public var id: String
	public var title: String
	public var detail: String
	public var symbol: String
	public var tool: AgentTool

	private static func http(
		_ id: String, _ title: String, _ detail: String, symbol: String, url: String,
		headers: [String: String]
	) -> MCPPreset {
		MCPPreset(
			id: id, title: title, detail: detail, symbol: symbol,
			tool: AgentTool(
				name: id, kind: "http",
				spec: .object([
					"type": .string("http"), "url": .string(url),
					"headers": .object(headers.mapValues { .string($0) }),
				])))
	}

	public static let all: [MCPPreset] = [
		http(
			"maskin", "Maskin", "Read and write objects, sessions and files in this workspace",
			symbol: "square.stack.3d.up", url: "${MASKIN_API_URL}/mcp",
			headers: [
				"Authorization": "Bearer ${MASKIN_API_KEY}",
				"X-Workspace-Id": "${MASKIN_WORKSPACE_ID}",
				"X-Maskin-Session-Id": "${SESSION_ID}",
			]),
		http(
			"linear", "Linear", "Issues and projects. Needs the Linear integration.",
			symbol: "checklist", url: "https://mcp.linear.app/mcp",
			headers: ["Authorization": "Bearer ${LINEAR_TOKEN}"]),
		http(
			"gmail", "Gmail", "Read and draft email. Needs the Gmail integration.",
			symbol: "envelope", url: "https://gmailmcp.googleapis.com/mcp/v1",
			headers: ["Authorization": "Bearer ${GMAIL_TOKEN}"]),
		http(
			"google-calendar", "Google Calendar", "Events and availability. Needs the integration.",
			symbol: "calendar", url: "https://calendarmcp.googleapis.com/mcp/v1",
			headers: ["Authorization": "Bearer ${GOOGLE_CALENDAR_TOKEN}"]),
		http(
			"posthog", "PostHog", "Product analytics. Needs the PostHog integration.",
			symbol: "chart.xyaxis.line", url: "https://mcp.posthog.com/mcp",
			headers: ["Authorization": "Bearer ${POSTHOG_TOKEN}"]),
		MCPPreset(
			id: "playwright", title: "Browser", detail: "Drive a browser for research and testing.",
			symbol: "safari",
			tool: AgentTool(
				name: "playwright", kind: "stdio",
				spec: .object([
					"type": .string("stdio"), "command": .string("npx"),
					"args": .array([
						.string("@playwright/mcp@latest"), .string("--cdp-endpoint"),
						.string("${BROWSER_CDP_URL}"),
					]),
				]))),
	]

	/// Presets not already on the agent.
	public static func available(excluding tools: [AgentTool]) -> [MCPPreset] {
		let have = Set(tools.map(\.name))
		return all.filter { !have.contains($0.id) }
	}
}
