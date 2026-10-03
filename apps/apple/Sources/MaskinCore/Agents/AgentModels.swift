import Foundation

/// What an agent is doing, resolved the way the web does (`getPortraitStatus`): a live session
/// beats the stored state, which beats the last run's outcome.
public enum AgentStatus: String, Sendable, CaseIterable, Codable {
	case running, paused, idle, failed

	/// Web filter bucket label ("Working" / "Idle" / "Failed"; paused agents stand by with idle).
	public var label: String {
		switch self {
		case .running: "Working"
		case .paused: "Paused"
		case .idle: "Idle"
		case .failed: "Failed"
		}
	}

	/// Status string understood by `StatusBadge`.
	public var badgeKey: String {
		switch self {
		case .running: "running"
		case .paused: "blocked"
		case .idle: "parked"
		case .failed: "failed"
		}
	}

	var sortRank: Int {
		switch self {
		case .running: 0
		case .paused: 1
		case .idle: 2
		case .failed: 3
		}
	}
}

/// A container session, trimmed to what the Agents screens show.
public struct AgentSession: Identifiable, Hashable, Sendable, Codable {
	public var id: String
	public var actorID: String
	/// Open set: `pending`, `starting`, `running`, `paused`, `completed`, `failed`, `timeout`, …
	public var status: String
	public var prompt: String
	public var currentActivity: String?
	public var interactive: Bool
	public var startedAt: Date?
	public var completedAt: Date?
	public var createdAt: Date?

	public init(
		id: String, actorID: String, status: String, prompt: String = "",
		currentActivity: String? = nil, interactive: Bool = false, startedAt: Date? = nil,
		completedAt: Date? = nil, createdAt: Date? = nil
	) {
		self.id = id
		self.actorID = actorID
		self.status = status
		self.prompt = prompt
		self.currentActivity = currentActivity
		self.interactive = interactive
		self.startedAt = startedAt
		self.completedAt = completedAt
		self.createdAt = createdAt
	}

	/// Statuses the web counts as "in progress" (`ACTIVE_STATUSES`).
	public static let activeStatuses: Set<String> = ["running", "starting", "pending"]

	public var isActive: Bool { Self.activeStatuses.contains(status) }
	public var isPaused: Bool { status == "paused" }
	/// A session the user can stop: anything still alive.
	public var isStoppable: Bool { isActive || isPaused }
	public var isFailure: Bool { status == "failed" || status == "timeout" }

	/// Newest activity, used for "last active" and ordering.
	public var activityDate: Date? { completedAt ?? startedAt ?? createdAt }

	/// Elapsed run time, when both ends are known.
	public func duration(now: Date = Date()) -> TimeInterval? {
		guard let start = startedAt ?? createdAt else { return nil }
		return max(0, (completedAt ?? (isActive ? now : start)).timeIntervalSince(start))
	}
}

/// One row of the Agents list: the actor plus its resolved status and latest session.
public struct AgentSummary: Identifiable, Hashable, Sendable, Codable {
	public var id: String
	public var name: String
	/// First line of the description: the one-line role label (web `deriveAgentKind`).
	public var role: String
	public var description: String?
	public var isSystem: Bool
	public var storedState: AgentStatus
	public var latestSession: AgentSession?
	public var sessionCount: Int
	public var createdAt: Date?

	public init(
		id: String, name: String, description: String? = nil, isSystem: Bool = false,
		storedState: AgentStatus = .idle, latestSession: AgentSession? = nil, sessionCount: Int = 0,
		createdAt: Date? = nil
	) {
		self.id = id
		self.name = name
		self.description = description
		self.role = AgentSummary.role(from: description)
		self.isSystem = isSystem
		self.storedState = storedState
		self.latestSession = latestSession
		self.sessionCount = sessionCount
		self.createdAt = createdAt
	}

	static func role(from description: String?) -> String {
		let line = description?.split(whereSeparator: \.isNewline).first
			.map { $0.trimmingCharacters(in: .whitespaces) }
		return (line?.isEmpty == false ? line : nil) ?? "Agent"
	}

	public var status: AgentStatus {
		AgentStatusResolver.resolve(stored: storedState, latest: latestSession)
	}
	public var lastActive: Date? { latestSession?.activityDate }
}

public enum AgentStatusResolver {
	public static func resolve(stored: AgentStatus, latest: AgentSession?) -> AgentStatus {
		if latest?.isActive == true { return .running }
		if stored != .idle { return stored }
		if latest?.isFailure == true { return .failed }
		return .idle
	}
}

/// One external capability an agent is wired to: an MCP server entry of `tools.mcpServers`.
/// `spec` keeps the full server definition so editing other fields (or other servers) never
/// drops a command, url, header or env var this screen doesn't show.
public struct AgentTool: Identifiable, Hashable, Sendable {
	public var name: String
	public var kind: String?
	public var spec: JSONValue?
	public var id: String { name }
	public init(name: String, kind: String? = nil, spec: JSONValue? = nil) {
		self.name = name
		self.kind = kind
		self.spec = spec
	}

	public func hash(into hasher: inout Hasher) {
		hasher.combine(name)
		hasher.combine(kind)
	}

	/// Where the server lives, for the row subtitle: the URL, or the command line. Headers and
	/// env are deliberately never shown: they hold tokens.
	public var location: String? {
		guard case .object(let spec)? = spec else { return nil }
		if case .string(let url)? = spec["url"] { return url }
		guard case .string(let command)? = spec["command"] else { return nil }
		var parts = [command]
		if case .array(let args)? = spec["args"] { parts += args.compactMap(\.stringValue) }
		return parts.joined(separator: " ")
	}

	/// The `tools` value to send back: `{ "mcpServers": { name: spec } }`.
	public static func toolsJSON(_ tools: [AgentTool]) -> JSONValue {
		var servers: [String: JSONValue] = [:]
		for tool in tools { servers[tool.name] = tool.spec ?? .object([:]) }
		return .object(["mcpServers": .object(servers)])
	}

	/// Reads `tools.mcpServers` (object keyed by server name, each optionally with a `type`).
	public static func summarize(_ tools: JSONValue?) -> [AgentTool] {
		guard case .object(let root)? = tools, case .object(let servers)? = root["mcpServers"] else {
			return []
		}
		return servers.keys.sorted().map { key in
			var kind: String?
			if case .object(let spec) = servers[key], case .string(let type)? = spec["type"] {
				kind = type
			} else if case .object(let spec) = servers[key], spec["command"] != nil {
				kind = "stdio"
			}
			return AgentTool(name: key, kind: kind, spec: servers[key])
		}
	}
}

/// The full profile behind the detail screen. Read-only in this phase.
public struct AgentProfile: Identifiable, Hashable, Sendable {
	public var id: String
	public var name: String
	public var description: String?
	public var systemPrompt: String?
	public var llmProvider: String?
	public var tools: [AgentTool]
	public var skills: [String]
	public var isSystem: Bool
	public var storedState: AgentStatus
	public var createdAt: Date?
	public var updatedAt: Date?

	public init(
		id: String, name: String, description: String? = nil, systemPrompt: String? = nil,
		llmProvider: String? = nil, tools: [AgentTool] = [], skills: [String] = [],
		isSystem: Bool = false, storedState: AgentStatus = .idle, createdAt: Date? = nil,
		updatedAt: Date? = nil
	) {
		self.id = id
		self.name = name
		self.description = description
		self.systemPrompt = systemPrompt
		self.llmProvider = llmProvider
		self.tools = tools
		self.skills = skills
		self.isSystem = isSystem
		self.storedState = storedState
		self.createdAt = createdAt
		self.updatedAt = updatedAt
	}

	public var role: String { AgentSummary.role(from: description) }
}

public struct AgentsError: Error, Equatable, Sendable {
	public var message: String
	public init(_ message: String) { self.message = message }
}

/// Run/pause/reset/stop only apply when the agent is in a state that allows them.
public enum AgentActions {
	/// Pause is offered while the agent is working. Run (which also resumes a paused session)
	/// otherwise.
	public static func canPause(_ status: AgentStatus) -> Bool { status == .running }
	public static func canRun(_ status: AgentStatus) -> Bool { status != .running }
	/// Only system agents (e.g. the Workspace Coach) have factory defaults to go back to.
	public static func canReset(isSystem: Bool) -> Bool { isSystem }
}
