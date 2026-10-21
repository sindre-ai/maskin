import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Settings, presented by the shell as a sheet or destination. Owns its `NavigationStack` and a
/// Done button.
///
/// ACCOUNT: your profile. SETUP: the workspace's name, skills, object types and extensions (web).
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
	@State private var services: SettingsServices
	@State private var confirmSignOut = false
	@State private var path: [SettingsRoute]
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
					NavigationLink(value: SettingsRoute.deleteAccount) {
						SettingsRow(
							symbol: "person.crop.circle.badge.minus", title: "Delete account", destructive: true)
					}
				}
				if services.workspaceId != nil {
					Section {
						NavigationLink(value: SettingsRoute.workspace) {
							SettingsRow(
								symbol: "building.2", title: "Workspace name", detail: services.workspace?.name)
						}
						NavigationLink(value: SettingsRoute.skills) {
							SettingsRow(symbol: "wand.and.stars", title: "Skills")
						}
						NavigationLink(value: SettingsRoute.objectTypes) {
							SettingsRow(symbol: "square.stack.3d.up", title: "Object types")
						}
						Button {
							if let url = services.webURL("extensions") { openURL(url) }
						} label: {
							SettingsRow(symbol: "puzzlepiece.extension", title: "Extensions", detail: "Opens in browser")
						}
						NavigationLink(value: SettingsRoute.deleteWorkspace) {
							SettingsRow(symbol: "trash", title: "Delete workspace", destructive: true)
						}
					} header: {
						Text("Setup")
					} footer: {
						Text("Members, integrations, billing and keys are under your profile.")
					}
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
				case .workspace:
					WorkspaceSettingsView(
						store: services.workspaceStore(), workspaceId: services.workspaceId ?? "",
						currentName: services.workspace?.name ?? "", role: services.role)
				case .skills: SkillsView(store: services.skillsStore())
				case .objectTypes: ObjectTypesView(store: services.schemaStore())
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
