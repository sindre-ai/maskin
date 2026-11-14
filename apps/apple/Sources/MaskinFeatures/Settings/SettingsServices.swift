import MaskinCore
import SwiftUI

/// Settings keeps the account and the workspace's setup pages (v19). The profile sheet still
/// reaches the same pages through `ProfileMenuItem`.
enum SettingsRoute: Hashable, Identifiable {
	var id: Self { self }
	case profile, notifications, workspace, skills, objectTypes, deleteAccount, deleteWorkspace
	case members, integrations, files, keys, triggers, billing
	case deviceSignIn, appLock, workspaces, advanced, nativeSurfaces
	/// `maskin://connect?code=`: Sign in a device with the code already typed.
	case deviceCode(String)
}

extension SettingsRoute {
	/// The page a `maskin://<ws>/settings/<page>` link opens.
	init(_ page: DeepLink.SettingsPage) {
		switch page {
		case .members: self = .members
		case .integrations: self = .integrations
		case .keys: self = .keys
		case .skills: self = .skills
		case .billing: self = .billing
		case .notifications: self = .notifications
		case .objects: self = .objectTypes
		}
	}
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

	/// Plain-HTTP transport for the routes newer than the OpenAPI snapshot, scoped to this workspace.
	var http: SettingsHTTP {
		SettingsHTTP(
			baseURL: environment.baseURL, clientSource: environment.clientSource,
			credentials: environment.auth.credentialsProvider, workspaceID: workspaceId)
	}

	func deviceSignInStore() -> DeviceSignInStore {
		DeviceSignInStore(api: APIDeviceSignInSource(http: http))
	}

	func invitationsStore() -> InvitationsStore {
		InvitationsStore(
			api: APIInvitationsSource(http: http), workspaceId: workspaceId ?? "", canManage: role.canManage)
	}

	func extensionsStore() -> ExtensionsStore {
		ExtensionsStore(api: APIExtensionsSource(http: http), canManage: role == .owner)
	}

	func claudeAccountStore() -> ClaudeAccountStore {
		ClaudeAccountStore(api: APIClaudeAccountSource(http: http))
	}

	/// Agents of this workspace, from the member list, for the Agent access page.
	func integrationAccessStore(integrationId: String, agents: [IntegrationAccessStore.AgentRef])
		-> IntegrationAccessStore
	{
		IntegrationAccessStore(
			api: APISettingsIntegrationAccessSource(http: http), integrationId: integrationId, agents: agents,
			canManage: role.canManage)
	}

	func connectWithKeyStore(providerID: String, providerName: String) -> ConnectWithKeyStore {
		ConnectWithKeyStore(
			providerID: providerID, providerName: providerName, api: APIIntegrationKeySource(http: http))
	}

	/// Folder watches on the Drive connection. Writable for everyone but viewers, like the web.
	func driveWatchesStore() -> DriveWatchesStore {
		DriveWatchesStore(api: APIDriveWatchesSource(http: http), canWrite: workspace?.role != "viewer")
	}

	func addToolServerStore() -> AddToolServerStore {
		AddToolServerStore(api: APIToolServersSource(http: http))
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

	/// The General switches. Nil without a workspace.
	func generalSettingsStore() -> GeneralSettingsStore? {
		guard let workspace else { return nil }
		let workspaces = environment.workspaces
		return GeneralSettingsStore(
			api: APIGeneralSettingsSource(http: http), actorId: actorId, workspace: workspace,
			canWritePrivacy: workspace.role != "viewer", refreshWorkspaces: { await workspaces.refresh() })
	}

	func membersStore() -> MembersStore {
		MembersStore(
			api: source ?? NoSettingsSource(), workspaceId: workspaceId ?? "", currentRole: role,
			currentActorId: actorId)
	}

	func integrationsStore() -> IntegrationsStore {
		#if os(iOS) || os(macOS)
			let webAuth: (any WebAuthenticating)? = SystemWebAuthenticator()
		#else
			let webAuth: (any WebAuthenticating)? = nil  // connecting stays on the web
		#endif
		return IntegrationsStore(
			api: source ?? NoSettingsSource(), currentRole: role, webAuth: webAuth)
	}

	/// The figures beside the rows of the account menu and the Settings page; nil without a workspace.
	func countsStore() -> SettingsCountsStore? {
		guard let source, let workspaceId else { return nil }
		let client = environment.client
		let files = APIFilesRemote(client: client, credentials: environment.auth.credentialsProvider)
		return SettingsCountsStore(
			workspaceId: workspaceId, members: source, integrations: source, skills: source, schema: source,
			billing: source,
			triggerCount: { try await APITriggersSource(client: client, workspaceID: workspaceId).list().count },
			fileCount: { limit in try await files.list(query: "", limit: limit, offset: 0).count })
	}

	func keychainStore() -> KeychainStore {
		let workspaceID = workspaceId ?? ""
		let source = APIKeychainSource(
			client: environment.client, workspaceID: workspaceID, baseURL: environment.baseURL,
			clientSource: environment.clientSource, credentials: environment.auth.credentialsProvider)
		return KeychainStore(api: source, currentActorID: actorId, canManageWorkspace: role.canManage)
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

	var deletionSource: APIDeletionSource {
		APIDeletionSource(
			baseURL: environment.baseURL, clientSource: environment.clientSource,
			credentials: environment.auth.credentialsProvider)
	}

	/// `didDelete` ends the session and wipes local state (the runtime's sign-out path).
	func accountDeletionStore(didDelete: @escaping @MainActor () async -> Void) -> AccountDeletionStore {
		AccountDeletionStore(api: deletionSource, didDelete: didDelete)
	}

	func workspaceDeletionStore(workspaceId: String) -> WorkspaceDeletionStore {
		let workspaces = environment.workspaces
		return WorkspaceDeletionStore(
			api: deletionSource, workspaceId: workspaceId,
			isLastWorkspace: workspaces.isLast(workspaceId),
			didDelete: {
				workspaces.removed(workspaceId)
				await workspaces.refresh()
			})
	}

	func billingStore() -> BillingStore { BillingStore(api: source ?? NoSettingsSource()) }

	func schemaStore() -> SchemaStore { SchemaStore(api: source ?? NoSettingsSource(), currentRole: role) }

	/// The MCP endpoint lives on the API origin.
	var mcpURL: URL { environment.baseURL.appendingPathComponent("mcp") }

	func mcpStore() -> MCPStore {
		MCPStore(api: source ?? NoSettingsSource(), serverURL: mcpURL, currentRole: role)
	}

	/// The signed-in key, for the Keys & MCP page to mask and to embed in the connect commands.
	var apiKey: @MainActor () -> SecretValue? {
		{ [environment] in environment.auth.session.map { SecretValue($0.apiKey) } }
	}

	func skillsStore() -> SkillsStore {
		SkillsStore(api: source ?? NoSettingsSource(), workspaceId: workspaceId ?? "")
	}
}

/// Stands in when no workspace is selected, so views still render and every call fails plainly.
struct NoSettingsSource: ProfileAPI, WorkspaceAdminAPI, MembersAPI, IntegrationsAPI, APIKeysAPI,
	SkillsAPI, BillingAPI, SchemaAPI, MCPAPI
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
	func startConnect(provider: String, idempotencyKey: String) async throws -> IntegrationConnectStart {
		throw failure
	}
	func pendingInstallations(integrationId: String) async throws -> [GitHubInstallationChoice] {
		throw failure
	}
	func selectInstallation(integrationId: String, installationId: String, idempotencyKey: String)
		async throws
	{ throw failure }
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
	func mcpServerInfo() async throws -> MCPServerInfo { throw failure }
	func mcpClients() async throws -> [MCPClient] { throw failure }
	func disconnectMCPClient(id: String, idempotencyKey: String) async throws { throw failure }
	func load() async throws -> WorkspaceSchema { throw failure }
	func save(_ schema: WorkspaceSchema, keys: Set<WorkspaceSchema.Key>, idempotencyKey: String)
		async throws
	{ throw failure }
}
