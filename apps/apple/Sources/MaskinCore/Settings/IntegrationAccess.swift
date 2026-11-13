import Foundation
import Observation

/// What an agent may do with an integration. There is no write-only level.
public enum AgentAccess: String, Sendable, Equatable, CaseIterable {
	case none, read, readWrite = "read_write"

	/// The server's own wording (`AGENT_ACCESS_LABELS`).
	public var label: String {
		switch self {
		case .none: "No access"
		case .read: "Read"
		case .readWrite: "Read & write"
		}
	}
}

public struct IntegrationGrants: Sendable, Equatable {
	public var defaultAccess: AgentAccess
	public var byAgent: [String: AgentAccess]
	public init(defaultAccess: AgentAccess, byAgent: [String: AgentAccess]) {
		self.defaultAccess = defaultAccess
		self.byAgent = byAgent
	}
}

/// One agent allowed to use the integration in a single chat ("Allow in this chat"). The server
/// leaves out grants that have run out.
public struct ChatGrant: Sendable, Equatable, Identifiable {
	public var id: String
	public var actorId: String
	/// Nil when it lasts until a person removes it.
	public var expiresAt: Date?
	public init(id: String, actorId: String, expiresAt: Date?) {
		self.id = id
		self.actorId = actorId
		self.expiresAt = expiresAt
	}

	/// "Only in one chat · expires Tue 14:30", worded as the web does.
	public var detail: String {
		guard let expiresAt else { return "Only in one chat" }
		return "Only in one chat · expires \(expiresAt.formatted(.dateTime.weekday(.abbreviated).hour().minute()))"
	}
}

public protocol IntegrationAccessAPI: Sendable {
	func grants(integrationId: String) async throws -> IntegrationGrants
	func setGrant(integrationId: String, actorId: String, access: AgentAccess, idempotencyKey: String)
		async throws
	func chatGrants(integrationId: String) async throws -> [ChatGrant]
	func removeChatGrant(integrationId: String, grantId: String, idempotencyKey: String) async throws
}

/// Integrations › one integration › Agent access: which agents may use it, and how. An agent with
/// no row of its own gets the integration's default, which the page shows as that agent's level.
@MainActor
@Observable
public final class IntegrationAccessStore {
	public struct AgentRef: Identifiable, Sendable, Equatable {
		public var id: String
		public var name: String
		public init(id: String, name: String) {
			self.id = id
			self.name = name
		}
	}

	public enum Phase: Equatable, Sendable {
		case idle, loading, loaded
		case failed(String)
	}

	public private(set) var phase: Phase = .idle
	public private(set) var grants = IntegrationGrants(defaultAccess: .none, byAgent: [:])
	public private(set) var chatGrants: [ChatGrant] = []
	public private(set) var busyIDs: Set<String> = []
	public private(set) var actionError: String?
	public let agents: [AgentRef]
	public let canManage: Bool

	@ObservationIgnored private let api: any IntegrationAccessAPI
	@ObservationIgnored private let integrationId: String

	public init(
		api: any IntegrationAccessAPI, integrationId: String, agents: [AgentRef], canManage: Bool
	) {
		self.api = api
		self.integrationId = integrationId
		self.agents = agents.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
		self.canManage = canManage
	}

	public func access(for agentId: String) -> AgentAccess {
		grants.byAgent[agentId] ?? grants.defaultAccess
	}

	public func load() async {
		if phase != .loaded { phase = .loading }
		do {
			grants = try await api.grants(integrationId: integrationId)
			phase = .loaded
			// The page works without this list: a failure to read it leaves what was shown.
			if let found = try? await api.chatGrants(integrationId: integrationId) { chatGrants = found }
		} catch {
			let message = (error as? SettingsError)?.message ?? "Couldn't load agent access."
			if phase == .loaded { actionError = message } else { phase = .failed(message) }
		}
	}

	/// Takes away one chat-only grant. Not optimistic: the row goes once the server has deleted it,
	/// and a second Remove of a grant that is already gone reads as done.
	public func removeChatGrant(_ grant: ChatGrant) async {
		guard canManage, !busyIDs.contains(grant.id) else { return }
		busyIDs.insert(grant.id)
		actionError = nil
		defer { busyIDs.remove(grant.id) }
		do {
			try await api.removeChatGrant(
				integrationId: integrationId, grantId: grant.id, idempotencyKey: UUID().uuidString)
			chatGrants.removeAll { $0.id == grant.id }
		} catch {
			actionError = (error as? SettingsError)?.message ?? "Couldn't remove that chat access."
		}
	}

	/// Optimistic; put back if the server refuses.
	public func set(_ access: AgentAccess, for agent: AgentRef) async {
		guard canManage, !busyIDs.contains(agent.id), self.access(for: agent.id) != access else { return }
		let before = grants.byAgent[agent.id]
		grants.byAgent[agent.id] = access
		busyIDs.insert(agent.id)
		actionError = nil
		defer { busyIDs.remove(agent.id) }
		do {
			try await api.setGrant(
				integrationId: integrationId, actorId: agent.id, access: access,
				idempotencyKey: UUID().uuidString)
		} catch {
			// Only this agent's entry goes back; another agent's change may be in flight.
			grants.byAgent[agent.id] = before
			actionError = (error as? SettingsError)?.message ?? "Couldn't change that agent's access."
		}
	}
}

public struct APISettingsIntegrationAccessSource: IntegrationAccessAPI {
	private let http: SettingsHTTP
	public init(http: SettingsHTTP) { self.http = http }

	private struct Wire: Decodable {
		struct Grant: Decodable {
			var actorId: String
			var access: String
		}
		var defaultAgentAccess: String
		var grants: [Grant]
	}

	public func grants(integrationId: String) async throws -> IntegrationGrants {
		let (data, status) = try await http.send("GET", "api/integrations/\(integrationId)/grants")
		guard status == 200 else {
			throw SettingsHTTP.error(status: status, data: data, fallback: "Couldn't load agent access.")
		}
		let wire = try SettingsHTTP.decode(Wire.self, data)
		var byAgent: [String: AgentAccess] = [:]
		for grant in wire.grants { byAgent[grant.actorId] = AgentAccess(rawValue: grant.access) ?? .none }
		return IntegrationGrants(
			defaultAccess: AgentAccess(rawValue: wire.defaultAgentAccess) ?? .none, byAgent: byAgent)
	}

	public func setGrant(
		integrationId: String, actorId: String, access: AgentAccess, idempotencyKey: String
	) async throws {
		let body = try JSONEncoder().encode(["access": access.rawValue])
		let (data, status) = try await http.send(
			"PUT", "api/integrations/\(integrationId)/grants/\(actorId)", body: body, key: idempotencyKey)
		guard status == 200 else {
			throw SettingsHTTP.error(
				status: status, data: data, fallback: "Couldn't change that agent's access.")
		}
	}

	private struct ListRow: Decodable {
		struct Grant: Decodable {
			var id: String
			var actorId: String
			var expiresAt: String?
		}
		var id: String
		var chatGrants: [Grant]?
	}

	/// The grants ride on the integration list, as they do for the web's Settings page.
	public func chatGrants(integrationId: String) async throws -> [ChatGrant] {
		let (data, status) = try await http.send("GET", "api/integrations")
		guard status == 200 else {
			throw SettingsHTTP.error(status: status, data: data, fallback: "Couldn't load chat access.")
		}
		let rows = try SettingsHTTP.decode([ListRow].self, data)
		return (rows.first { $0.id == integrationId }?.chatGrants ?? []).map {
			ChatGrant(id: $0.id, actorId: $0.actorId, expiresAt: Self.date($0.expiresAt))
		}
	}

	public func removeChatGrant(integrationId: String, grantId: String, idempotencyKey: String) async throws {
		let (data, status) = try await http.send(
			"DELETE", "api/integrations/\(integrationId)/chat-grants/\(grantId)", key: idempotencyKey)
		// Already gone (a second press, or removed on another device) is the state the person asked for.
		guard status == 200 || status == 404 else {
			throw SettingsHTTP.error(status: status, data: data, fallback: "Couldn't remove that chat access.")
		}
	}

	static func date(_ string: String?) -> Date? {
		guard let string else { return nil }
		return (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(string))
			?? (try? Date.ISO8601FormatStyle().parse(string))
	}
}
