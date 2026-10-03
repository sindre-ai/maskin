import Foundation

@testable import MaskinCore

/// One fake for every Settings API. State sits behind a lock because the protocols are async and
/// nonisolated; `failure` makes the next-and-every call throw.
final class FakeSettings: ProfileAPI, WorkspaceAdminAPI, MembersAPI, IntegrationsAPI, APIKeysAPI,
	SkillsAPI, BillingAPI, SchemaAPI, @unchecked Sendable
{
	private let lock = NSLock()
	private var _failure: SettingsError?
	private var _calls: [String] = []
	private var _keys: [String] = []

	var members: [WorkspaceMember] = []
	var providerList: [IntegrationProvider] = []
	var connectedList: [ConnectedIntegration] = []
	var skillList: [WorkspaceSkill] = []
	/// Held in a closure, not a property, so reflecting the fake (or a store holding it) can't
	/// print the key; the leak tests would otherwise be measuring this fake.
	private var keyProvider: @Sendable () -> String = { "ank_0123456789abcdef0123456789abcdef" }
	var regeneratedKey: String {
		get { keyProvider() }
		set { keyProvider = { newValue } }
	}
	var skillBodies: [String: String] = [:]
	var billingUsage = BillingUsage(
		plan: "pro", status: .active, usedCents: 2_500, capCents: 10_000, creditBalanceCents: 0,
		resetsInMs: 3 * 86_400_000)
	var schemaValue = WorkspaceSchema(
		fieldDefinitions: ["bet": [PropertyDefinition(name: "owner_team", kind: .text)]],
		statuses: ["bet": ["signal", "active", "done"]], displayNames: ["bet": "Bet"])
	private var _savedKeys: [Set<WorkspaceSchema.Key>] = []
	private var _saved: [WorkspaceSchema] = []
	var savedKeys: [Set<WorkspaceSchema.Key>] { lock.withLock { _savedKeys } }
	var savedSchemas: [WorkspaceSchema] { lock.withLock { _saved } }
	var createdWorkspace = CreatedWorkspace(id: "ws-new", name: "New")

	var failure: SettingsError? {
		get { lock.withLock { _failure } }
		set { lock.withLock { _failure = newValue } }
	}
	var calls: [String] { lock.withLock { _calls } }
	var idempotencyKeys: [String] { lock.withLock { _keys } }

	private func record(_ name: String, key: String? = nil) throws {
		try lock.withLock {
			_calls.append(name)
			if let key { _keys.append(key) }
			if let _failure { throw _failure }
		}
	}

	func rename(actorId: String, name: String, idempotencyKey: String) async throws -> ProfileInfo {
		try record("rename-actor", key: idempotencyKey)
		return ProfileInfo(actorId: actorId, name: name, email: "me@example.com")
	}
	func rename(workspaceId: String, name: String, idempotencyKey: String) async throws {
		try record("rename-workspace", key: idempotencyKey)
	}
	func create(name: String, idempotencyKey: String) async throws -> CreatedWorkspace {
		try record("create-workspace", key: idempotencyKey)
		return createdWorkspace
	}
	func list(workspaceId: String) async throws -> [WorkspaceMember] {
		try record("list-members")
		return members
	}
	func setRole(workspaceId: String, actorId: String, role: MemberRole, idempotencyKey: String)
		async throws
	{ try record("set-role", key: idempotencyKey) }
	func remove(workspaceId: String, actorId: String, idempotencyKey: String) async throws {
		try record("remove-member", key: idempotencyKey)
	}
	func add(workspaceId: String, actorId: String, role: MemberRole, idempotencyKey: String)
		async throws
	{
		try record("add-member", key: idempotencyKey)
		lock.withLock { members.append(WorkspaceMember(actorId: actorId, name: "New Person", isAgent: false, role: role)) }
	}
	func providers() async throws -> [IntegrationProvider] {
		try record("providers")
		return providerList
	}
	func connected() async throws -> [ConnectedIntegration] {
		try record("connected")
		return connectedList
	}
	func disconnect(id: String, idempotencyKey: String) async throws {
		try record("disconnect", key: idempotencyKey)
	}
	func regenerate(actorId: String) async throws -> SecretValue {
		try record("regenerate")
		return SecretValue(regeneratedKey)
	}
	func list(workspaceId: String) async throws -> [WorkspaceSkill] {
		try record("list-skills")
		return skillList
	}
	func content(workspaceId: String, name: String) async throws -> String {
		try record("skill-content")
		return skillBodies[name] ?? "# \(name)"
	}
	func create(workspaceId: String, name: String, content: String, idempotencyKey: String)
		async throws
	{
		try record("create-skill", key: idempotencyKey)
		lock.withLock {
			skillBodies[name] = content
			skillList.append(WorkspaceSkill(id: "id-\(name)", name: name, summary: nil, isValid: true))
		}
	}
	func update(workspaceId: String, name: String, content: String, idempotencyKey: String)
		async throws
	{
		try record("update-skill", key: idempotencyKey)
		lock.withLock { skillBodies[name] = content }
	}
	func delete(workspaceId: String, name: String, idempotencyKey: String) async throws {
		try record("delete-skill", key: idempotencyKey)
		lock.withLock { skillList.removeAll { $0.name == name } }
	}
	func usage() async throws -> BillingUsage {
		try record("usage")
		return billingUsage
	}
	func load() async throws -> WorkspaceSchema {
		try record("load-schema")
		return schemaValue
	}
	func save(_ schema: WorkspaceSchema, keys: Set<WorkspaceSchema.Key>, idempotencyKey: String)
		async throws
	{
		try record("save-schema", key: idempotencyKey)
		lock.withLock {
			_savedKeys.append(keys)
			_saved.append(schema)
			schemaValue = schema
		}
	}
}

func member(
	_ id: String, _ name: String, _ role: MemberRole = .member, agent: Bool = false
) -> WorkspaceMember {
	WorkspaceMember(actorId: id, name: name, isAgent: agent, role: role)
}
