import MaskinCore
import SwiftUI

extension View {
	/// Adds the shell's single trailing control: the account menu (notifications, search,
	/// workspace switcher, settings, sign out). Unread notifications show as a badge on the
	/// For you tab, not here. Apply to a screen's root content, inside its `NavigationStack`.
	/// Inside the signed-in shell the inbox is the shared sheet `AppRuntime` owns; standalone
	/// (previews) the modifier owns its own.
	public func shellToolbar(environment: AppEnvironment) -> some View {
		modifier(ShellToolbarModifier(environment: environment))
	}
}

private struct ShellToolbarModifier: ViewModifier {
	let environment: AppEnvironment
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var showNotifications = false
	@State private var showWorkspaces = false

	func body(content: Content) -> some View {
		content
			.toolbar {
				ToolbarItem(placement: .primaryAction) {
					ProfileMenu(environment: environment, runtime: runtime, showNotifications: {
						if let runtime { runtime.showNotifications = true } else { showNotifications = true }
					}) { showWorkspaces = true }
				}
			}
			.sheet(isPresented: $showNotifications) {
				NotificationsScreen(environment: environment)
			}
			.sheet(isPresented: $showWorkspaces) {
				WorkspaceSwitcher(environment: environment)
					.presentationDetents([.medium, .large])
			}
	}
}

/// Account menu: who is signed in, which workspace, switch, sign out.
struct ProfileMenu: View {
	let environment: AppEnvironment
	var runtime: AppRuntime?
	let showNotifications: () -> Void
	let switchWorkspace: () -> Void
	@State private var confirmSignOut = false

	var body: some View {
		let session = environment.auth.session
		Menu {
			if let session {
				Section {
					Text(session.name)
					if let email = session.email { Text(email) }
				}
			}
			Button(action: showNotifications) {
				let unread = runtime?.notifications.unreadCount ?? 0
				Label(
					unread > 0 ? "Notifications (\(unread))" : "Notifications",
					systemImage: unread > 0 ? "bell.badge" : "bell")
			}
			if let runtime, !ShellTab.searchIsTab {
				Button {
					runtime.showSearch = true
				} label: {
					Label("Search", systemImage: "magnifyingglass")
				}
			}
			Button(action: switchWorkspace) {
				Label(
					environment.workspaces.selected?.name ?? "Choose workspace",
					systemImage: "arrow.left.arrow.right")
			}
			if let runtime {
				Button {
					runtime.showSettings = true
				} label: {
					Label("Settings", systemImage: "gearshape")
				}
			}
			Button(role: .destructive) {
				confirmSignOut = true
			} label: {
				Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
			}
		} label: {
			Label("Account", systemImage: "person.crop.circle")
		}
		// Signing out discards writes still waiting to send, so ask first (Settings does too).
		.confirmationDialog("Sign out of Maskin?", isPresented: $confirmSignOut, titleVisibility: .visible) {
			Button("Sign out", role: .destructive) {
				if let runtime {
					Task { await runtime.signOut() }
				} else {
					environment.signOut()
				}
			}
		} message: {
			Text("Anything still waiting to send will be discarded.")
		}
	}
}
