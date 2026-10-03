import Foundation

/// Network seams for the Settings stores. Protocols so each store tests without a server; the
/// generated client stays inside `APISettingsSource.swift`.

public protocol ProfileAPI: Sendable {
	/// `PATCH /api/actors/{id}`.
	func rename(actorId: String, name: String, idempotencyKey: String) async throws -> ProfileInfo
}

public struct CreatedWorkspace: Sendable, Equatable {
	public var id: String
	public var name: String
	public init(id: String, name: String) {
		self.id = id
		self.name = name
	}
}

public protocol WorkspaceAdminAPI: Sendable {
	/// `PATCH /api/workspaces/{id}` with only the name.
	func rename(workspaceId: String, name: String, idempotencyKey: String) async throws
	/// `POST /api/workspaces`.
	func create(name: String, idempotencyKey: String) async throws -> CreatedWorkspace
}

public protocol MembersAPI: Sendable {
	func list(workspaceId: String) async throws -> [WorkspaceMember]
	/// `PATCH …/members/{actorId}`; the server accepts only `admin` and `member`.
	func setRole(workspaceId: String, actorId: String, role: MemberRole, idempotencyKey: String)
		async throws
	func remove(workspaceId: String, actorId: String, idempotencyKey: String) async throws
	/// `POST …/members`: adds an existing actor by id.
	func add(workspaceId: String, actorId: String, role: MemberRole, idempotencyKey: String)
		async throws
}

public protocol IntegrationsAPI: Sendable {
	func providers() async throws -> [IntegrationProvider]
	func connected() async throws -> [ConnectedIntegration]
	func disconnect(id: String, idempotencyKey: String) async throws
}

public protocol APIKeysAPI: Sendable {
	/// `POST /api/actors/{id}/api-keys`. The previous key stops working at once. Deliberately has
	/// no idempotency key: the server's ledger would cache the plaintext response for 24 hours.
	func regenerate(actorId: String) async throws -> SecretValue
}

public protocol SkillsAPI: Sendable {
	func list(workspaceId: String) async throws -> [WorkspaceSkill]
	/// `GET …/skills/{name}`: the skill's markdown body.
	func content(workspaceId: String, name: String) async throws -> String
	/// `POST …/skills`.
	func create(workspaceId: String, name: String, content: String, idempotencyKey: String)
		async throws
	/// `PUT …/skills/{name}`.
	func update(workspaceId: String, name: String, content: String, idempotencyKey: String)
		async throws
	/// `DELETE …/skills/{name}`.
	func delete(workspaceId: String, name: String, idempotencyKey: String) async throws
}

public protocol BillingAPI: Sendable {
	/// `GET /api/billing/usage`.
	func usage() async throws -> BillingUsage
}

public protocol SchemaAPI: Sendable {
	/// The selected workspace's schema settings, from `GET /api/workspaces`.
	func load() async throws -> WorkspaceSchema
	/// `PATCH /api/workspaces/{id}` with only the schema keys that changed. The server merges
	/// settings per top-level key, so each key sent here replaces that key whole.
	func save(_ schema: WorkspaceSchema, keys: Set<WorkspaceSchema.Key>, idempotencyKey: String)
		async throws
}
