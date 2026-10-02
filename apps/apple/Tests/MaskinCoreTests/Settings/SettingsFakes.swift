import Foundation

@testable import MaskinCore

/// One fake for every Settings API. State sits behind a lock because the protocols are async and
/// nonisolated; `failure` makes the next-and-every call throw.
final class FakeSettings: ProfileAPI, WorkspaceAdminAPI, MembersAPI, IntegrationsAPI, APIKeysAPI,
	SkillsAPI, @unchecked Sendable
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
}

func member(
	_ id: String, _ name: String, _ role: MemberRole = .member, agent: Bool = false
) -> WorkspaceMember {
	WorkspaceMember(actorId: id, name: name, isAgent: agent, role: role)
}
