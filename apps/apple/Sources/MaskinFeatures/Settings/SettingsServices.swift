import MaskinCore
import SwiftUI

enum SettingsRoute: Hashable, Identifiable {
	var id: Self { self }
	case profile, workspace, members, integrations, apiKey, skills, billing, objectTypes, mcp
}

/// The Settings slice's dependencies, built once per screen from `AppEnvironment`.
@MainActor
struct SettingsServices {
	let environment: AppEnvironment

	init(environment: AppEnvironment) {
		self.environment = environment
	}

	/// Read live, never captured: the workspace can change while Settings is open (Workspace ›
	/// Create and switch), and every store built afterwards must use the new header.
	var source: APISettingsSource? {
		environment.workspaceId.map {
			APISettingsSource(client: environment.client, workspaceID: $0)
		}
	}

	var workspaceId: String? { environment.workspaceId }
	var workspace: WorkspaceSummary? { environment.workspaces.selected }
	var actorId: String { environment.auth.session?.actorId ?? "" }

	/// The signed-in person's role in the selected workspace; unknown means least privilege.
	var role: MemberRole { MemberRole(serverValue: workspace?.role ?? "member") }

	/// Where web-only settings live. Production serves the web app from the API's origin; in dev
	/// the web app is on another port, so `MaskinWebBaseURL` (Info.plist) overrides it.
	var webBaseURL: URL {
		Self.webBaseURL(
			override: Bundle.main.object(forInfoDictionaryKey: "MaskinWebBaseURL") as? String,
			apiBaseURL: environment.baseURL)
	}

	static func webBaseURL(override: String?, apiBaseURL: URL) -> URL {
		if let override, let url = URL(string: override), url.scheme?.hasPrefix("http") == true {
			return url
		}
		return apiBaseURL
	}

	func webURL(_ path: String) -> URL? {
		guard let workspaceId else { return nil }
		return webBaseURL.appendingPathComponent(workspaceId).appendingPathComponent("settings")
			.appendingPathComponent(path)
	}

	func profileStore() -> ProfileStore {
		let session = environment.auth.session
		return ProfileStore(
			api: source ?? NoSettingsSource(),
			profile: ProfileInfo(
				actorId: actorId, name: session?.name ?? "", email: session?.email),
			updateSessionName: { [environment] in environment.auth.updateName($0) })
	}

	func workspaceStore() -> WorkspaceSettingsStore {
		let workspaces = environment.workspaces
		return WorkspaceSettingsStore(
			api: source ?? NoSettingsSource(),
			refreshWorkspaces: { await workspaces.refresh() },
			selectWorkspace: { workspaces.select($0) })
	}

	func membersStore() -> MembersStore {
		MembersStore(
			api: source ?? NoSettingsSource(), workspaceId: workspaceId ?? "", currentRole: role,
			currentActorId: actorId)
	}

	func integrationsStore() -> IntegrationsStore {
		IntegrationsStore(api: source ?? NoSettingsSource(), currentRole: role)
	}

	func apiKeyStore() -> APIKeyStore {
		// Always this actor's own id: the app never rotates anyone else's key. The new key is
		// adopted synchronously, before any other await, so this device isn't signed out.
		let auth = environment.auth
		return APIKeyStore(
			api: source ?? NoSettingsSource(), actorId: actorId,
			adopt: { try auth.adoptRotatedKey($0) },
			willRotate: { auth.beginKeyRotation() }, didFailRotation: { auth.cancelKeyRotation() })
	}

	func billingStore() -> BillingStore { BillingStore(api: source ?? NoSettingsSource()) }

	func schemaStore() -> SchemaStore { SchemaStore(api: source ?? NoSettingsSource(), currentRole: role) }

	/// The MCP endpoint lives on the API origin.
	var mcpURL: URL { environment.baseURL.appendingPathComponent("mcp") }

	func skillsStore() -> SkillsStore {
		SkillsStore(api: source ?? NoSettingsSource(), workspaceId: workspaceId ?? "")
	}
}

/// Stands in when no workspace is selected, so views still render and every call fails plainly.
struct NoSettingsSource: ProfileAPI, WorkspaceAdminAPI, MembersAPI, IntegrationsAPI, APIKeysAPI,
	SkillsAPI, BillingAPI, SchemaAPI
{
	private var failure: SettingsError { SettingsError("Pick a workspace first.") }
	func rename(actorId: String, name: String, idempotencyKey: String) async throws -> ProfileInfo {
		throw failure
	}
	func rename(workspaceId: String, name: String, idempotencyKey: String) async throws { throw failure }
	func create(name: String, idempotencyKey: String) async throws -> CreatedWorkspace { throw failure }
	func list(workspaceId: String) async throws -> [WorkspaceMember] { throw failure }
	func setRole(workspaceId: String, actorId: String, role: MemberRole, idempotencyKey: String)
		async throws
	{ throw failure }
	func remove(workspaceId: String, actorId: String, idempotencyKey: String) async throws {
		throw failure
	}
	func providers() async throws -> [IntegrationProvider] { throw failure }
	func connected() async throws -> [ConnectedIntegration] { throw failure }
	func disconnect(id: String, idempotencyKey: String) async throws { throw failure }
	func regenerate(actorId: String) async throws -> SecretValue {
		throw failure
	}
	func list(workspaceId: String) async throws -> [WorkspaceSkill] { throw failure }
	func add(workspaceId: String, actorId: String, role: MemberRole, idempotencyKey: String)
		async throws
	{ throw failure }
	func content(workspaceId: String, name: String) async throws -> String { throw failure }
	func create(workspaceId: String, name: String, content: String, idempotencyKey: String)
		async throws
	{ throw failure }
	func update(workspaceId: String, name: String, content: String, idempotencyKey: String)
		async throws
	{ throw failure }
	func delete(workspaceId: String, name: String, idempotencyKey: String) async throws { throw failure }
	func usage() async throws -> BillingUsage { throw failure }
	func load() async throws -> WorkspaceSchema { throw failure }
	func save(_ schema: WorkspaceSchema, keys: Set<WorkspaceSchema.Key>, idempotencyKey: String)
		async throws
	{ throw failure }
}
