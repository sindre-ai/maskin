import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The page a `SettingsRoute` opens. One place, shared by the Settings page and the account menu,
/// so a row opens the same screen wherever it is tapped.
struct SettingsRouteView: View {
	let route: SettingsRoute
	let environment: AppEnvironment
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@Environment(AppLockController.self) private var appLock: AppLockController?

	private var services: SettingsServices { SettingsServices(environment: environment) }

	var body: some View {
		switch route {
		case .profile: ProfileView(store: services.profileStore())
		case .notifications: SettingsNotificationsPage(environment: environment)
		case .workspace:
			WorkspaceSettingsView(
				store: services.workspaceStore(), workspaceId: services.workspaceId ?? "",
				currentName: services.workspace?.name ?? "", role: services.role)
		case .members:
			MembersView(store: services.membersStore(), invitations: services.invitationsStore())
		case .integrations:
			IntegrationsView(
				store: services.integrationsStore(), webSetupURL: services.webURL("integrations"),
				services: services)
		case .files: FilesListScreen(environment: environment)
		case .skills: SkillsView(store: services.skillsStore())
		case .objectTypes:
			ObjectTypesView(store: services.schemaStore(), extensions: services.extensionsStore())
		case .deviceSignIn: DeviceSignInView(store: services.deviceSignInStore())
		case .deviceCode(let code):
			DeviceSignInView(store: services.deviceSignInStore(), initialCode: code)
		case .workspaces:
			WorkspacesPage(workspaces: environment.workspaces, creator: services.workspaceStore())
		case .appLock:
			if let appLock { AppLockSettingsPage(lock: appLock) }
		case .keys:
			KeysPage(
				store: services.apiKeyStore(), mcp: services.mcpStore(), keychain: services.keychainStore(),
				workspaceId: services.workspaceId ?? "", apiKey: services.apiKey)
		case .triggers:
			TriggersPage(environment: environment, workspaceID: services.workspaceId ?? "")
		case .billing:
			BillingView(
				store: services.billingStore(),
				manageURL: services.role == .owner ? services.webURL("billing") : nil)
		case .advanced: AdvancedPage(environment: environment)
		case .nativeSurfaces: NativeSurfacesPage(environment: environment)
		case .deleteAccount:
			DeleteAccountView(
				store: services.accountDeletionStore { [environment, runtime] in
					if let runtime { await runtime.signOut() } else { environment.signOut() }
				})
		case .deleteWorkspace:
			DeleteWorkspaceView(
				store: services.workspaceDeletionStore(workspaceId: services.workspaceId ?? ""))
		}
	}
}

/// Notifications, pushed from Settings. Loads the workspace's flows itself for the Lock Screen
/// group, since Settings has no flows list of its own.
struct SettingsNotificationsPage: View {
	let environment: AppEnvironment
	@State private var loops: LoopsStore?

	init(environment: AppEnvironment) {
		self.environment = environment
		if let workspaceID = environment.workspaceId {
			_loops = State(
				initialValue: LoopsStore(
					api: APILoopsSource(client: environment.client, workspaceID: workspaceID),
					events: nil, cache: environment.snapshotCache))
		}
	}

	var body: some View {
		NotificationsPage(flows: loops?.loops ?? [], workspaces: environment.workspaces.workspaces)
			.task { await loops?.refresh() }
	}
}
