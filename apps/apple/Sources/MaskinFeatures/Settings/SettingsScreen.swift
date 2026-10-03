import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Settings, presented by the shell as a sheet or destination. Owns its `NavigationStack` and a
/// Done button.
///
/// In scope: profile, workspace, members (add, roles, remove), integrations (status, disconnect;
/// connecting happens in the browser), the actor API key, skills (create, edit, delete), object
/// types and properties, plan and usage (read-only; changes open the web), MCP connection
/// commands, sign out. Extensions open on the web.
public struct SettingsScreen: View {
	@Environment(\.dismiss) private var dismiss
	@Environment(\.openURL) private var openURL
	/// Present inside the signed-in shell; nil in previews. Sign-out goes through it so the push
	/// token is unregistered and this account's queued writes are discarded.
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	private let environment: AppEnvironment
	@State private var services: SettingsServices
	@State private var confirmSignOut = false

	public init(environment: AppEnvironment) {
		self.environment = environment
		_services = State(initialValue: SettingsServices(environment: environment))
	}

	public var body: some View {
		NavigationStack {
			List {
				Section("Account") {
					NavigationLink(value: SettingsRoute.profile) {
						SettingsRow(
							symbol: "person.crop.circle", title: "Profile",
							detail: environment.auth.session?.name)
					}
					NavigationLink(value: SettingsRoute.apiKey) {
						SettingsRow(symbol: "key", title: "API key")
					}
				}
				if services.workspaceId != nil {
					Section("Workspace") {
						NavigationLink(value: SettingsRoute.workspace) {
							SettingsRow(
								symbol: "building.2", title: "Workspace", detail: services.workspace?.name)
						}
						NavigationLink(value: SettingsRoute.members) {
							SettingsRow(
								symbol: "person.2", title: "Members",
								detail: services.workspace.map { "\($0.memberCount)" })
						}
						NavigationLink(value: SettingsRoute.integrations) {
							SettingsRow(symbol: "link", title: "Integrations")
						}
						NavigationLink(value: SettingsRoute.skills) {
							SettingsRow(symbol: "wand.and.stars", title: "Skills")
						}
						NavigationLink(value: SettingsRoute.objectTypes) {
							SettingsRow(symbol: "square.stack.3d.up", title: "Object types")
						}
					}
					Section {
						NavigationLink(value: SettingsRoute.billing) {
							SettingsRow(symbol: "creditcard", title: "Plan and usage")
						}
						NavigationLink(value: SettingsRoute.mcp) {
							SettingsRow(symbol: "point.3.connected.trianglepath.dotted", title: "Connect Claude")
						}
						Button {
							if let url = services.webURL("extensions") { openURL(url) }
						} label: {
							SettingsRow(symbol: "puzzlepiece.extension", title: "Extensions", detail: "Opens in browser")
						}
					}
				}
				Section("About") {
					LabeledContent("Version", value: Self.versionString)
					Button("Sign out", role: .destructive) { confirmSignOut = true }
						.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
				}
			}
			.settingsListStyle()
			.navigationTitle("Settings")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
			}
			.navigationDestination(for: SettingsRoute.self) { route in
				switch route {
				case .profile: ProfileView(store: services.profileStore())
				case .workspace:
					WorkspaceSettingsView(
						store: services.workspaceStore(), workspaceId: services.workspaceId ?? "",
						currentName: services.workspace?.name ?? "", role: services.role)
				case .members: MembersView(store: services.membersStore())
				case .integrations:
					IntegrationsView(
						store: services.integrationsStore(), webSetupURL: services.webURL("integrations"))
				case .apiKey: APIKeyView(store: services.apiKeyStore())
				case .skills: SkillsView(store: services.skillsStore())
				case .objectTypes: ObjectTypesView(store: services.schemaStore())
				case .billing: BillingView(store: services.billingStore())
				case .mcp:
					MCPConnectView(
						serverURL: services.mcpURL, workspaceId: services.workspaceId ?? "",
						apiKey: { [environment] in
							environment.auth.session.map { SecretValue($0.apiKey) }
						})
				}
			}
			.confirmationDialog("Sign out of Maskin?", isPresented: $confirmSignOut, titleVisibility: .visible) {
				Button("Sign out", role: .destructive) {
					dismiss()
					if let runtime { Task { await runtime.signOut() } } else { environment.signOut() }
				}
			} message: {
				Text("You'll need your email and password to sign back in.")
			}
		}
	}

	static var versionString: String {
		let info = Bundle.main.infoDictionary
		let version = info?["CFBundleShortVersionString"] as? String ?? "dev"
		let build = info?["CFBundleVersion"] as? String
		return build.map { "\(version) (\($0))" } ?? version
	}
}
