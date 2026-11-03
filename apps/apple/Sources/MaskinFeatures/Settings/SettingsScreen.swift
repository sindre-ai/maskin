import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Settings, presented by the shell as a sheet or destination. Owns its `NavigationStack` and a
/// Done button.
///
/// ACCOUNT: your profile. NOTIFICATIONS: push permission, preferences and Lock Screen flows
/// (`NotificationsPage`). SETUP: the workspace's name, skills, object types and extensions (web).
/// Members, Integrations, Billing and Keys & MCP are not here: they live in the profile sheet's
/// WORKSPACE group (handoff `7-Chat.md` §10). Log out at the end.
public struct SettingsScreen: View {
	@Environment(\.dismiss) private var dismiss
	@Environment(\.openURL) private var openURL
	@Environment(\.isPushedInHostStack) private var pushed
	/// Present inside the signed-in shell; nil in previews. Sign-out goes through it so the push
	/// token is unregistered and this account's queued writes are discarded.
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	private let environment: AppEnvironment
	private let connectCode: String?
	@State private var services: SettingsServices
	@State private var confirmSignOut = false
	@State private var path: [SettingsRoute]
	/// Present inside the signed-in app; nil in previews, which hides the Security section.
	@Environment(AppLockController.self) private var appLock: AppLockController?

	/// `initialRoute` opens straight onto one page (More's Members, Billing…), with Settings
	/// behind it.
	public init(environment: AppEnvironment) { self.init(environment: environment, initialRoute: nil) }

	/// Opens on "Sign in a device" with the code from `maskin://connect?code=` already filled in;
	/// without a code it is the plain Settings hub.
	public init(environment: AppEnvironment, connectCode: String?) {
		self.init(
			environment: environment, initialRoute: connectCode == nil ? nil : .deviceSignIn,
			connectCode: connectCode)
	}

	init(environment: AppEnvironment, initialRoute: SettingsRoute?, connectCode: String? = nil) {
		self.connectCode = connectCode
		self.environment = environment
		_path = State(initialValue: initialRoute.map { [$0] } ?? [])
		_services = State(initialValue: SettingsServices(environment: environment))
	}

	public var body: some View {
		if pushed { hub } else { NavigationStack(path: $path) { hub } }
	}

	private var hub: some View {
		Group {
			List {
				Section("Account") {
					NavigationLink(value: SettingsRoute.profile) {
						SettingsRow(
							symbol: "person.crop.circle", title: "Your profile",
							detail: environment.auth.session?.name)
					}
					NavigationLink(value: SettingsRoute.workspaces) {
						SettingsRow(
							symbol: "square.stack", title: "Workspaces", detail: services.workspace?.name)
					}
					NavigationLink(value: SettingsRoute.deleteAccount) {
						SettingsRow(
							symbol: "person.crop.circle.badge.minus", title: "Delete account", destructive: true)
					}
				}
				Section("Notifications") {
					NavigationLink(value: SettingsRoute.notifications) {
						SettingsRow(symbol: "bell", title: "Notifications")
					}
				}
				if services.workspaceId != nil {
					Section {
						NavigationLink(value: SettingsRoute.workspace) {
							SettingsRow(
								symbol: "building.2", title: "Workspace name", detail: services.workspace?.name)
						}
						NavigationLink(value: SettingsRoute.members) {
							SettingsRow(
								symbol: "person.2", title: "Members",
								detail: services.workspace.map { "\($0.memberCount)" })
						}
						NavigationLink(value: SettingsRoute.integrations) {
							SettingsRow(symbol: "link", title: "Integrations")
						}
						NavigationLink(value: SettingsRoute.autonomy) {
							SettingsRow(symbol: "slider.horizontal.3", title: "Autonomy and guardrails")
						}
						NavigationLink(value: SettingsRoute.skills) {
							SettingsRow(symbol: "wand.and.stars", title: "Skills")
						}
						NavigationLink(value: SettingsRoute.keys) {
							SettingsRow(symbol: "key", title: "Keys and MCP")
						}
						NavigationLink(value: SettingsRoute.triggers) {
							SettingsRow(symbol: "bolt", title: "Triggers")
						}
						NavigationLink(value: SettingsRoute.objectTypes) {
							SettingsRow(symbol: "square.stack.3d.up", title: "Item types")
						}
						NavigationLink(value: SettingsRoute.extensions) {
							SettingsRow(symbol: "puzzlepiece.extension", title: "Extensions")
						}
						NavigationLink(value: SettingsRoute.claudeImport) {
							SettingsRow(symbol: "arrow.down.circle", title: "Import from Claude")
						}
						NavigationLink(value: SettingsRoute.billing) {
							SettingsRow(symbol: "creditcard", title: "Billing")
						}
					} header: {
						Text("Setup")
					}
				}
				Section {
					NavigationLink(value: SettingsRoute.deviceSignIn) {
						SettingsRow(symbol: "tv", title: "Sign in a device")
					}
					if let appLock, appLock.availability != .unavailable || appLock.isEnabled {
						NavigationLink(value: SettingsRoute.appLock) {
							SettingsRow(
								symbol: "lock", title: "App lock", detail: appLock.isEnabled ? "On" : "Off")
						}
					}
				} header: {
					Text("Security")
				} footer: {
					Text("Sign in a device approves the code your Apple TV or Mac shows.")
				}
				if services.workspaceId != nil {
					Section {
						NavigationLink(value: SettingsRoute.deleteWorkspace) {
							SettingsRow(symbol: "trash", title: "Delete workspace", destructive: true)
						}
					}
				}
				Section("About") {
					// Signed in, privacy choices are the workspace's own settings on the web app.
					if let url = services.webSettingsURL {
						Button("Privacy & data") { openURL(url) }
					}
					// The public pages; a link only appears when its Info.plist key is set.
					if let url = AuthConfig.current.privacyURL {
						Button("Privacy policy") { openURL(url) }
					}
					if let url = AuthConfig.current.termsURL {
						Button("Terms of Service") { openURL(url) }
					}
					LabeledContent("Version", value: Self.versionString)
				}
				// Its own centred red card, as the mockup draws it.
				Section {
					Button("Log out", role: .destructive) { confirmSignOut = true }
						.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
				}
			}
			.settingsListStyle()
			.navigationTitle("Settings")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				if !pushed {
					ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
				}
			}
			.navigationDestination(for: SettingsRoute.self) { route in
				switch route {
				case .profile: ProfileView(store: services.profileStore())
				case .notifications: SettingsNotificationsPage(environment: environment)
				case .workspace:
					WorkspaceSettingsView(
						store: services.workspaceStore(), workspaceId: services.workspaceId ?? "",
						currentName: services.workspace?.name ?? "", role: services.role)
				case .skills: SkillsView(store: services.skillsStore())
				case .objectTypes: ObjectTypesView(store: services.schemaStore())
				case .workspaces:
					WorkspacesPage(workspaces: environment.workspaces, creator: services.workspaceStore())
				case .members:
					MembersView(store: services.membersStore())
				case .integrations:
					IntegrationsView(
						store: services.integrationsStore(), webSetupURL: services.webURL("integrations"))
				case .billing:
					BillingView(
						store: services.billingStore(),
						manageURL: services.role == .owner ? services.webURL("billing") : nil)
				case .keys:
					KeysPage(
						store: services.apiKeyStore(), mcp: services.mcpStore(),
						workspaceId: services.workspaceId ?? "", apiKey: services.apiKey,
						toolServers: HTTPToolServersSource(http: services.http))
				case .triggers:
					if let workspaceID = services.workspaceId {
						TriggersPage(environment: environment, workspaceID: workspaceID)
					}
				case .extensions:
					ExtensionsPage(store: services.extensionsStore(), webURL: services.webURL("extensions"))
				case .claudeImport:
					ClaudeImportPage(
						store: services.claudeConnectionStore(), webURL: services.webURL("keys"),
						canManage: services.role.canManage)
				case .deviceSignIn:
					DeviceSignInPage(
						store: services.deviceApprovalStore(initialCode: connectCode), account: environment.auth.session?.email,
						workspaceName: services.workspace?.name)
				case .autonomy:
					if let workspaceID = services.workspaceId {
						AutonomyView(
							store: AutonomyStore(
								workspaceID: workspaceID, actorID: services.actorId,
								storage: UserDefaultsAutonomyStorage()))
					}
				case .deviceCode(let code):
					DeviceSignInPage(
						store: services.deviceApprovalStore(initialCode: code),
						account: environment.auth.session?.email, workspaceName: services.workspace?.name)
				case .appLock:
					if let appLock { AppLockSettingsPage(lock: appLock) }
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
			.confirmationDialog("Log out of Maskin?", isPresented: $confirmSignOut, titleVisibility: .visible) {
				Button("Log out", role: .destructive) {
					dismiss()
					if let runtime { Task { await runtime.signOut() } } else { environment.signOut() }
				}
			} message: {
				Text("You will need your email and password to sign back in.")
			}
		}
	}

	private func appLockBinding(_ lock: AppLockController) -> Binding<Bool> {
		Binding(
			get: { lock.isEnabled },
			set: { on in Task { await lock.setEnabled(on) } })
	}

	static func appLockFooter(_ availability: AppLockAvailability, delay: AppLockDelay = .default) -> String {
		let how: String
		switch availability {
		case .biometric(let name): how = "Unlock with \(name) or your device passcode."
		case .passcodeOnly, .unavailable: how = "Unlock with your device passcode."
		}
		return "\(how) Maskin locks when you open it, and \(delay == .immediately ? "as soon as you leave it" : "after \(delay.label) in the background")."
	}

	static var versionString: String {
		let info = Bundle.main.infoDictionary
		let version = info?["CFBundleShortVersionString"] as? String ?? "dev"
		let build = info?["CFBundleVersion"] as? String
		return build.map { "\(version) (\($0))" } ?? version
	}
}

/// Notifications, pushed from Settings. Loads the workspace's flows itself for the Lock Screen
/// group, since Settings has no flows list of its own.
private struct SettingsNotificationsPage: View {
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
