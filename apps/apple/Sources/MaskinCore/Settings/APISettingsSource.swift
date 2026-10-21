import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production sources for the Settings stores. The generated client's operation names stay
/// inside this file. Error messages are fixed sentences: no response bodies, ids or keys are
/// interpolated into anything that could be logged or shown.
public struct APISettingsSource: ProfileAPI, WorkspaceAdminAPI, MembersAPI, IntegrationsAPI,
	APIKeysAPI, SkillsAPI, BillingAPI, SchemaAPI, MCPAPI
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

	public func add(workspaceId: String, actorId: String, role: MemberRole, idempotencyKey: String)
		async throws
	{
		// The server only accepts admin | member here; an owner is never added through this route.
		guard
			let serverRole = Operations.post_sol_api_sol_workspaces_sol__lcub_id_rcub__sol_members.Input.Body
				.jsonPayload.rolePayload(rawValue: role.rawValue)
		else { throw SettingsError("People can only be added as an admin or a member.") }
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.post_sol_api_sol_workspaces_sol__lcub_id_rcub__sol_members(
				.init(path: .init(id: workspaceId), body: .json(.init(actor_id: actorId, role: serverRole))))
		}
		switch output {
		case .created: return
		case .forbidden: throw SettingsError("Only a workspace admin can add people.")
		case .notFound: throw SettingsError("No one has that id. Ask them to copy it from their Profile.")
		default: throw SettingsError("Couldn't add that person.")
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

	public func startConnect(provider: String, idempotencyKey: String) async throws
		-> IntegrationConnectStart
	{
		let body = Operations.post_sol_api_sol_integrations_sol__lcub_provider_rcub__sol_connect.Input.Body
			.json(.init(native_return_url: IntegrationConnectOutcome.returnURL))
		let linkedInBody = Operations.post_sol_api_sol_integrations_sol_linkedin_hyphen_unipile_sol_connect
			.Input.Body.json(.init(native_return_url: IntegrationConnectOutcome.returnURL))
		do {
			let installURL: String?
			let integrationId: String?
			if provider == "linkedin-unipile" {
				let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
					try await client.post_sol_api_sol_integrations_sol_linkedin_hyphen_unipile_sol_connect(
						.init(headers: .init(x_hyphen_workspace_hyphen_id: workspaceID), body: linkedInBody))
				}
				guard case .ok(let ok) = output else { throw SettingsError("Couldn't start connecting.") }
				let json = try ok.body.json
				installURL = json.install_url
				integrationId = json.integration_id
			} else {
				let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
					try await client.post_sol_api_sol_integrations_sol__lcub_provider_rcub__sol_connect(
						.init(
							path: .init(provider: provider),
							headers: .init(x_hyphen_workspace_hyphen_id: workspaceID), body: body))
				}
				guard case .ok(let ok) = output else { throw SettingsError("Couldn't start connecting.") }
				let json = try ok.body.json
				installURL = json.install_url
				integrationId = json.integration_id
			}
			// Only an https install URL is ever handed to the sign-in sheet.
			guard let installURL, let url = URL(string: installURL), url.scheme?.lowercased() == "https"
			else { throw SettingsError("Couldn't start connecting.") }
			return IntegrationConnectStart(installURL: url, integrationId: integrationId)
		} catch let error as SettingsError {
			throw error
		} catch {
			throw Self.map(error)
		}
	}

	public func pendingInstallations(integrationId: String) async throws -> [GitHubInstallationChoice] {
		do {
			let output = try await client.get_sol_api_sol_integrations_sol_github_sol_pending_hyphen_selection_sol__lcub_id_rcub_(
				.init(
					path: .init(id: integrationId),
					headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
			guard case .ok(let ok) = output else {
				throw SettingsError("Couldn't load your GitHub accounts.")
			}
			return try ok.body.json.installations.map {
				GitHubInstallationChoice(id: $0.installationId, name: $0.ownerLogin)
			}
		} catch let error as SettingsError {
			throw error
		} catch {
			throw Self.map(error)
		}
	}

	public func selectInstallation(
		integrationId: String, installationId: String, idempotencyKey: String
	) async throws {
		do {
			let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
				try await client.post_sol_api_sol_integrations_sol_github_sol_select_hyphen_installation(
					.init(
						headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
						body: .json(.init(integration_id: integrationId, installation_id: installationId))))
			}
			guard case .ok = output else { throw SettingsError("Couldn't connect that GitHub account.") }
		} catch let error as SettingsError {
			throw error
		} catch {
			throw Self.map(error)
		}
	}

	/// A transport failure that means "no connection" becomes `SettingsError.offline`; anything
	/// else is a fixed sentence (no response bodies or URLs in messages).
	private static func map(_ error: any Error) -> SettingsError {
		var underlying: any Error = error
		if let client = error as? ClientError { underlying = client.underlyingError }
		if let url = underlying as? URLError {
			switch url.code {
			case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff,
				.cannotFindHost, .cannotConnectToHost, .timedOut:
				return .offline
			default: break
			}
		}
		return SettingsError("Couldn't reach Maskin.")
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

	// MARK: MCP (STUB — no endpoints in openapi.json)

	// The API exposes the MCP server at `POST /mcp` but has no route that lists its tools, its
	// connected clients, or revokes one. These throw a fixed sentence so the page says plainly
	// that the information is not available, instead of inventing a route. Replace each body when
	// the endpoint lands (see the API follow-ups in the handoff report).
	public func mcpServerInfo() async throws -> MCPServerInfo { throw SettingsError.mcpNotAvailable }
	public func mcpClients() async throws -> [MCPClient] { throw SettingsError.mcpNotAvailable }
	public func disconnectMCPClient(id: String, idempotencyKey: String) async throws {
		throw SettingsError.mcpNotAvailable
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

	public func content(workspaceId: String, name: String) async throws -> String {
		let output = try await client.get_sol_api_sol_workspaces_sol__lcub_workspaceId_rcub__sol_skills_sol__lcub_name_rcub_(
			.init(path: .init(workspaceId: workspaceId, name: name)))
		switch output {
		case .ok(let ok): return try ok.body.json.content
		default: throw SettingsError("Couldn't open that skill.")
		}
	}

	public func create(workspaceId: String, name: String, content: String, idempotencyKey: String)
		async throws
	{
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.post_sol_api_sol_workspaces_sol__lcub_workspaceId_rcub__sol_skills(
				.init(path: .init(workspaceId: workspaceId), body: .json(.init(name: name, content: content))))
		}
		switch output {
		case .created: return
		case .badRequest: throw SettingsError("That skill isn't valid. Check the name and content.")
		case .forbidden: throw SettingsError("You don't have permission to add skills.")
		case .conflict: throw SettingsError("A skill with that name already exists.")
		default: throw SettingsError("Couldn't save the skill.")
		}
	}

	public func update(workspaceId: String, name: String, content: String, idempotencyKey: String)
		async throws
	{
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.put_sol_api_sol_workspaces_sol__lcub_workspaceId_rcub__sol_skills_sol__lcub_name_rcub_(
				.init(path: .init(workspaceId: workspaceId, name: name), body: .json(.init(content: content))))
		}
		switch output {
		case .ok: return
		case .forbidden: throw SettingsError("You don't have permission to edit skills.")
		default: throw SettingsError("Couldn't save the skill.")
		}
	}

	public func delete(workspaceId: String, name: String, idempotencyKey: String) async throws {
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.delete_sol_api_sol_workspaces_sol__lcub_workspaceId_rcub__sol_skills_sol__lcub_name_rcub_(
				.init(path: .init(workspaceId: workspaceId, name: name)))
		}
		switch output {
		case .ok: return
		case .forbidden: throw SettingsError("You don't have permission to delete skills.")
		default: throw SettingsError("Couldn't delete the skill.")
		}
	}

	// MARK: Billing

	public func usage() async throws -> BillingUsage {
		let output = try await client.get_sol_api_sol_billing_sol_usage(
			.init(headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		switch output {
		case .ok(let ok):
			let row = try ok.body.json
			return BillingUsage(
				plan: row.plan.rawValue, status: BillingUsage.Status(rawValue: row.status.rawValue) ?? .active,
				usedCents: row.usd_cents_used, capCents: row.hard_cap_usd_cents,
				creditBalanceCents: row.credit_balance_cents, resetsInMs: row.period_resets_in_ms)
		default:
			throw SettingsError("Couldn't load your plan.")
		}
	}

	// MARK: Schema

	public func load() async throws -> WorkspaceSchema {
		let output = try await client.get_sol_api_sol_workspaces()
		guard case .ok(let ok) = output else { throw SettingsError("Couldn't load object types.") }
		guard let row = try ok.body.json.first(where: { $0.id == workspaceID }) else {
			throw SettingsError("Couldn't find this workspace.")
		}
		let data = try JSONEncoder().encode(row.settings)
		return SettingsSchemaWire.decode(settingsJSON: data)
	}

	public func save(
		_ schema: WorkspaceSchema, keys: Set<WorkspaceSchema.Key>, idempotencyKey: String
	) async throws {
		let body = SettingsSchemaWire.patchBody(schema, keys: keys)
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.patch_sol_api_sol_workspaces_sol__lcub_id_rcub_(
				.init(path: .init(id: workspaceID), body: .json(body)))
		}
		switch output {
		case .ok: return
		case .forbidden: throw SettingsError("Only a workspace admin can change object types.")
		case .badRequest: throw SettingsError("That change isn't allowed.")
		default: throw SettingsError("Couldn't save that change.")
		}
	}
}
