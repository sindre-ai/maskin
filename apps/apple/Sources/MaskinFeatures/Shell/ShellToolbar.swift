import MaskinCore
import SwiftUI

extension View {
	/// Adds the shell's trailing toolbar: notifications bell and the profile menu (workspace
	/// switcher, sign out). Apply to a screen's root content, inside its `NavigationStack`.
	/// Inside the signed-in shell the bell shows the unread count and opens the shared inbox
	/// (`AppRuntime` owns that sheet); standalone (previews) the modifier owns its own.
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
				ToolbarItemGroup(placement: .primaryAction) {
					NotificationsBell(unread: runtime?.notifications.unreadCount ?? 0) {
						if let runtime { runtime.showNotifications = true } else { showNotifications = true }
					}
					ProfileMenu(environment: environment, runtime: runtime) { showWorkspaces = true }
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

/// The bell, with a dot-and-count badge while anything is unread.
struct NotificationsBell: View {
	let unread: Int
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			Label("Notifications", systemImage: unread > 0 ? "bell.badge" : "bell")
		}
		.accessibilityLabel(unread > 0 ? "Notifications, \(unread) unread" : "Notifications")
	}
}

/// Account menu: who is signed in, which workspace, switch, sign out.
struct ProfileMenu: View {
	let environment: AppEnvironment
	var runtime: AppRuntime?
	let switchWorkspace: () -> Void

	var body: some View {
		let session = environment.auth.session
		Menu {
			if let session {
				Section {
					Text(session.name)
					if let email = session.email { Text(email) }
				}
			}
			Button(action: switchWorkspace) {
				Label(
					environment.workspaces.selected?.name ?? "Choose workspace",
					systemImage: "arrow.left.arrow.right")
			}
			Button(role: .destructive) {
				if let runtime {
					Task { await runtime.signOut() }
				} else {
					environment.signOut()
				}
			} label: {
				Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
			}
		} label: {
			Label("Account", systemImage: "person.crop.circle")
		}
	}
}
