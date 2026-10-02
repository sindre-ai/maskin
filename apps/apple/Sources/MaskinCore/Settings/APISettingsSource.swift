import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production sources for the Settings stores. The generated client's operation names stay
/// inside this file. Error messages are fixed sentences: no response bodies, ids or keys are
/// interpolated into anything that could be logged or shown.
public struct APISettingsSource: ProfileAPI, WorkspaceAdminAPI, MembersAPI, IntegrationsAPI,
	APIKeysAPI, SkillsAPI
{
	private let client: Client
	public let workspaceID: String

	public init(client: Client, workspaceID: String) {
		self.client = client
		self.workspaceID = workspaceID
	}

	private static func date(_ s: String?) -> Date? {
		guard let s else { return nil }
		let f = ISO8601DateFormatter()
		f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		if let d = f.date(from: s) { return d }
		f.formatOptions = [.withInternetDateTime]
		return f.date(from: s)
	}

	// MARK: Profile

	public func rename(actorId: String, name: String, idempotencyKey: String) async throws
		-> ProfileInfo
	{
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.patch_sol_api_sol_actors_sol__lcub_id_rcub_(
				.init(
					path: .init(id: actorId),
					headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
					body: .json(.init(name: name))))
		}
		switch output {
		case .ok(let ok):
			let row = try ok.body.json
			return ProfileInfo(actorId: row.id, name: row.name, email: row.email)
		default:
			throw SettingsError("Couldn't save your name.")
		}
	}

	// MARK: Workspace

	public func rename(workspaceId: String, name: String, idempotencyKey: String) async throws {
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.patch_sol_api_sol_workspaces_sol__lcub_id_rcub_(
				.init(path: .init(id: workspaceId), body: .json(.init(name: name))))
		}
		switch output {
		case .ok: return
		case .forbidden: throw SettingsError("Only a workspace admin can rename it.")
		default: throw SettingsError("Couldn't rename the workspace.")
		}
	}

	public func create(name: String, idempotencyKey: String) async throws -> CreatedWorkspace {
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.post_sol_api_sol_workspaces(.init(body: .json(.init(name: name))))
		}
		switch output {
		case .created(let created):
			let row = try created.body.json
			return CreatedWorkspace(id: row.id, name: row.name)
		case .forbidden: throw SettingsError("Your plan doesn't allow another workspace.")
		default: throw SettingsError("Couldn't create the workspace.")
		}
	}

	// MARK: Members

	public func list(workspaceId: String) async throws -> [WorkspaceMember] {
		let output = try await client.get_sol_api_sol_workspaces_sol__lcub_id_rcub__sol_members(
			.init(path: .init(id: workspaceId)))
		switch output {
		case .ok(let ok):
			return try ok.body.json.map {
				WorkspaceMember(
					actorId: $0.actorId, name: $0.name, isAgent: $0._type == "agent",
					role: MemberRole(serverValue: $0.role), joinedAt: Self.date($0.joinedAt))
			}
		default:
			throw SettingsError("Couldn't load members.")
		}
	}

	public func setRole(
		workspaceId: String, actorId: String, role: MemberRole, idempotencyKey: String
	) async throws {
		guard let wire = Operations.patch_sol_api_sol_workspaces_sol__lcub_id_rcub__sol_members_sol__lcub_actorId_rcub_
			.Input.Body.jsonPayload.rolePayload(rawValue: role.rawValue)
		else { throw SettingsError("That role can't be assigned here.") }
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.patch_sol_api_sol_workspaces_sol__lcub_id_rcub__sol_members_sol__lcub_actorId_rcub_(
				.init(path: .init(id: workspaceId, actorId: actorId), body: .json(.init(role: wire))))
		}
		switch output {
		case .ok: return
		case .forbidden: throw SettingsError("Only a workspace admin can change roles.")
		case .badRequest: throw SettingsError("That role change isn't allowed.")
		default: throw SettingsError("Couldn't change the role.")
		}
	}

	public func remove(workspaceId: String, actorId: String, idempotencyKey: String) async throws {
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.delete_sol_api_sol_workspaces_sol__lcub_id_rcub__sol_members_sol__lcub_actorId_rcub_(
				.init(path: .init(id: workspaceId, actorId: actorId)))
		}
		switch output {
		case .ok: return
		case .forbidden: throw SettingsError("Only a workspace admin can remove members.")
		case .conflict:
			throw SettingsError("This member owns billing. Move billing to someone else first.")
		default: throw SettingsError("Couldn't remove the member.")
		}
	}

	// MARK: Integrations

	public func providers() async throws -> [IntegrationProvider] {
		let output = try await client.get_sol_api_sol_integrations_sol_providers(.init())
		switch output {
		case .ok(let ok):
			return try ok.body.json.map { row in
				let kind: IntegrationProvider.AuthKind
				switch row.authType {
				case .oauth2, .oauth2_custom: kind = .oauth
				case .api_key: kind = .apiKey
				case .manual: kind = .manual
				}
				return IntegrationProvider(
					id: row.name, displayName: row.displayName, authKind: kind,
					showsEmail: row.externalIdDisplay == .email, eventCount: row.events.count)
			}
		default:
			throw SettingsError("Couldn't load integrations.")
		}
	}

	public func connected() async throws -> [ConnectedIntegration] {
		let output = try await client.get_sol_api_sol_integrations(
			.init(headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		switch output {
		case .ok(let ok):
			return try ok.body.json.map {
				ConnectedIntegration(
					id: $0.id, provider: $0.provider, status: $0.status, externalId: $0.externalId,
					missingScopes: $0.missingScopes?.count ?? 0, needsReconnect: $0.needsReconnect ?? false)
			}
		default:
			throw SettingsError("Couldn't load integrations.")
		}
	}

	public func disconnect(id: String, idempotencyKey: String) async throws {
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.delete_sol_api_sol_integrations_sol__lcub_id_rcub_(
				.init(
					path: .init(id: id), headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		}
		guard case .ok = output else { throw SettingsError("Couldn't disconnect the integration.") }
	}

	// MARK: API keys

	public func regenerate(actorId: String) async throws -> SecretValue {
		// Pinned to nil even inside an outer scope: the response carries the plaintext key, and a
		// keyed write would have the server's idempotency ledger store it for 24 hours.
		let output = try await IdempotencyKey.$current.withValue(nil) {
			try await client.post_sol_api_sol_actors_sol__lcub_id_rcub__sol_api_hyphen_keys(
				.init(path: .init(id: actorId)))
		}
		switch output {
		case .ok(let ok): return SecretValue(try ok.body.json.api_key)
		default: throw SettingsError("Couldn't regenerate the key.")
		}
	}

	// MARK: Skills

	public func list(workspaceId: String) async throws -> [WorkspaceSkill] {
		let output = try await client.get_sol_api_sol_workspaces_sol__lcub_workspaceId_rcub__sol_skills(
			.init(path: .init(workspaceId: workspaceId)))
		switch output {
		case .ok(let ok):
			return try ok.body.json.map {
				WorkspaceSkill(id: $0.id, name: $0.name, summary: $0.description, isValid: $0.isValid)
			}
		default:
			throw SettingsError("Couldn't load skills.")
		}
	}
}
