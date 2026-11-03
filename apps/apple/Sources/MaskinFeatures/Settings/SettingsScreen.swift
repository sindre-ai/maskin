import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Settings, presented by the shell as a sheet or destination. Owns its `NavigationStack` and a
/// Done button.
///
/// ACCOUNT: your profile. NOTIFICATIONS: push permission, preferences and Lock Screen flows
/// (`NotificationsPage`). SETUP: the workspace's name, skills, item types (with their extensions) and sign-in for another device.
/// Members (with Invite people), Integrations, Files, Skills, Autonomy, Keys and MCP, Triggers, Item types
/// and Billing all open from SETUP (v19), with a figure beside a row only when it is known. DANGER ZONE holds both delete actions. Log out at the end.
public struct SettingsScreen: View {
	@Environment(\.dismiss) private var dismiss
	@Environment(\.openURL) private var openURL
	@Environment(\.isPushedInHostStack) private var pushed
	/// Present inside the signed-in shell; nil in previews. Sign-out goes through it so the push
	/// token is unregistered and this account's queued writes are discarded.
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	private let environment: AppEnvironment
	@State private var services: SettingsServices
	@State private var confirmSignOut = false
	@State private var path: [SettingsRoute]
	@State private var counts: SettingsCountsStore?
	@State private var showInvite = false
	@State private var invitations: InvitationsStore?
	/// Present inside the signed-in app; nil in previews, which hides the Security section.
	@Environment(AppLockController.self) private var appLock: AppLockController?

	/// `initialRoute` opens straight onto one page (More's Members, Billing…), with Settings
	/// behind it.
	public init(environment: AppEnvironment) { self.init(environment: environment, initialRoute: nil) }

	init(environment: AppEnvironment, initialRoute: SettingsRoute?) {
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
				}
				if services.workspaceId != nil {
					Section {
						NavigationLink(value: SettingsRoute.workspace) {
							SettingsRow(
								symbol: "building.2", title: "Workspace name", detail: services.workspace?.name)
						}
					}
				}
				Section {
					NavigationLink(value: SettingsRoute.notifications) {
						SettingsRow(symbol: "bell", title: "Notifications")
					}
					if services.workspaceId != nil {
						NavigationLink(value: SettingsRoute.members) {
							SettingsRow(
								symbol: "person.2", title: "Members", detail: SettingsCountsStore.detail(counts?.members))
						}
						if services.role.canManage {
							Button {
								invitations = services.invitationsStore()
								showInvite = true
							} label: {
								SettingsRow(symbol: "person.badge.plus", title: "Invite people")
							}
						}
						NavigationLink(value: SettingsRoute.integrations) {
							SettingsRow(
								symbol: "puzzlepiece.extension", title: "Integrations", detail: counts?.integrationsDetail)
						}
						NavigationLink(value: SettingsRoute.files) {
							SettingsRow(symbol: "doc.text", title: "Files", detail: SettingsCountsStore.detail(counts?.files))
						}
						NavigationLink(value: SettingsRoute.skills) {
							SettingsRow(
								symbol: "wand.and.stars", title: "Skills", detail: SettingsCountsStore.detail(counts?.skills))
						}
						NavigationLink(value: SettingsRoute.autonomy) {
							SettingsRow(symbol: "slider.horizontal.3", title: "Autonomy and guardrails")
						}
						NavigationLink(value: SettingsRoute.keys) {
							SettingsRow(symbol: "key", title: "Keys and MCP")
						}
						NavigationLink(value: SettingsRoute.triggers) {
							SettingsRow(symbol: "bolt", title: "Triggers", detail: SettingsCountsStore.detail(counts?.triggers))
						}
						NavigationLink(value: SettingsRoute.objectTypes) {
							SettingsRow(
								symbol: "square.stack.3d.up", title: "Item types",
								detail: SettingsCountsStore.detail(counts?.itemTypes))
						}
						NavigationLink(value: SettingsRoute.billing) {
							SettingsRow(symbol: "creditcard", title: "Billing", detail: counts?.plan)
						}
						NavigationLink(value: SettingsRoute.deviceSignIn) {
							SettingsRow(symbol: "appletv", title: "Sign in a device")
						}
					}
				} header: {
					Text("Setup")
				}
				if let appLock, appLock.availability != .unavailable || appLock.isEnabled {
					Section {
						Toggle(isOn: appLockBinding(appLock)) {
							SettingsRow(symbol: "lock", title: "App lock")
						}
						.disabled(appLock.isAuthenticating)
					} header: {
						Text("Security")
					} footer: {
						Text(Self.appLockFooter(appLock.availability))
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
				// Both irreversible actions live here, in the danger colour, each on its own row.
				Section("Danger zone") {
					if services.workspaceId != nil {
						NavigationLink(value: SettingsRoute.deleteWorkspace) {
							SettingsRow(symbol: "trash", title: "Delete workspace", destructive: true)
						}
					}
					NavigationLink(value: SettingsRoute.deleteAccount) {
						SettingsRow(
							symbol: "person.crop.circle.badge.minus", title: "Delete account", destructive: true)
					}
				}
				// Its own centred red card, as the mockup draws it.
				Section {
					Button("Log out", role: .destructive) { confirmSignOut = true }
						.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
				}
			}
			.settingsListStyle()
			.task { await loadCounts() }
			.sheet(isPresented: $showInvite) {
				if let invitations { InviteByEmailSheet(store: invitations) }
			}
			.navigationTitle("Settings")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				if !pushed {
					ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
				}
			}
			.navigationDestination(for: SettingsRoute.self) { destination($0) }
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

	@ViewBuilder private func destination(_ route: SettingsRoute) -> some View {
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
				case .autonomy:
					AutonomyView(
						store: AutonomyStore(
							workspaceID: services.workspaceId ?? "", actorID: services.actorId,
							storage: UserDefaultsAutonomyStorage()))
				case .keys:
					KeysPage(
						store: services.apiKeyStore(), mcp: services.mcpStore(),
						workspaceId: services.workspaceId ?? "", apiKey: services.apiKey)
				case .triggers:
					TriggersPage(environment: environment, workspaceID: services.workspaceId ?? "")
				case .billing:
					BillingView(
						store: services.billingStore(),
						manageURL: services.role == .owner ? services.webURL("billing") : nil)
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

	private func loadCounts() async {
		guard let source = services.source, let workspaceId = services.workspaceId else { return }
		if counts == nil {
			let client = environment.client
			let files = APIFilesRemote(client: client, credentials: environment.auth.credentialsProvider)
			counts = SettingsCountsStore(
				workspaceId: workspaceId, members: source, integrations: source, skills: source, schema: source,
				billing: source,
				triggerCount: { try await APITriggersSource(client: client, workspaceID: workspaceId).list().count },
				fileCount: { limit in try await files.list(query: "", limit: limit, offset: 0).count })
		}
		await counts?.load()
	}

	private func appLockBinding(_ lock: AppLockController) -> Binding<Bool> {
		Binding(
			get: { lock.isEnabled },
			set: { on in Task { await lock.setEnabled(on) } })
	}

	static func appLockFooter(_ availability: AppLockAvailability) -> String {
		let how: String
		switch availability {
		case .biometric(let name): how = "Unlock with \(name) or your device passcode."
		case .passcodeOnly, .unavailable: how = "Unlock with your device passcode."
		}
		return "\(how) Maskin locks when you open it, and after \(Int(AppLockController.gracePeriod)) seconds in the background."
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
