import MaskinCore
import MaskinDesign
import SwiftUI

/// The More tab: who is signed in, the workspace, settings and sign out. Replaces the account
/// button that used to sit in every screen's toolbar.
struct MoreScreen: View {
	let environment: AppEnvironment
	@Bindable var runtime: AppRuntime
	@State private var showWorkspaces = false
	@State private var showMarketplace = false
	@State private var confirmSignOut = false
	@Environment(\.horizontalSizeClass) private var sizeClass

	var body: some View {
		NavigationStack {
			List {
				if let session = environment.auth.session {
					Section {
						VStack(alignment: .leading, spacing: MaskinSpace.s1) {
							Text(session.name).maskinText(.headline).foregroundStyle(MaskinColor.ink)
							if let email = session.email {
								Text(email).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
							}
						}
						.accessibilityElement(children: .combine)
						.listRowSeparator(.hidden)
					}
				}
				Section {
					row("Notifications", "bell", badge: runtime.notifications.unreadCount) {
						runtime.showNotifications = true
					}
					if sizeClass == .compact {
						row("Agents", "person.2") { runtime.showAgents = true }
					}
					row("Files", "doc.text") { runtime.showFiles = true }
					if environment.workspaceId != nil {
						row("Marketplace", "square.grid.2x2") { showMarketplace = true }
					}
				}
				Section {
					Button {
						showWorkspaces = true
					} label: {
						LabeledContent {
							Text(environment.workspaces.selected?.name ?? "Choose workspace")
								.foregroundStyle(MaskinColor.ink4)
						} label: {
							Label("Switch workspace", systemImage: "arrow.left.arrow.right")
						}
					}
					.listRowSeparator(.hidden)
					Button {
						runtime.showSettings = true
					} label: {
						Label("Settings", systemImage: "gearshape")
					}
					.listRowSeparator(.hidden)
				}
				Section {
					Button(role: .destructive) {
						confirmSignOut = true
					} label: {
						Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
					}
					.listRowSeparator(.hidden)
				}
			}
			.listStyle(.plain)
			.scrollContentBackground(.hidden)
			.background(MaskinSurface.grouped)
			.foregroundStyle(MaskinColor.ink)
			.shellToolbar(environment: environment, title: "More")
			// Signing out discards writes still waiting to send, so ask first (Settings does too).
			.confirmationDialog("Sign out of Maskin?", isPresented: $confirmSignOut, titleVisibility: .visible) {
				Button("Sign out", role: .destructive) { Task { await runtime.signOut() } }
			} message: {
				Text("Anything still waiting to send will be discarded.")
			}
			.sheet(isPresented: $showMarketplace) {
				if let workspaceID = environment.workspaceId {
					MarketplaceSheet(
						environment: environment, workspaceID: workspaceID,
						onOpenLoop: { _ in
							showMarketplace = false
							runtime.selectedTab = .loops
						})
				}
			}
			.sheet(isPresented: $showWorkspaces) {
				WorkspaceSwitcher(environment: environment)
					.presentationDetents([.medium, .large])
			}
		}
	}

	private func row(
		_ title: String, _ symbol: String, badge: Int = 0, action: @escaping () -> Void
	) -> some View {
		Button(action: action) {
			LabeledContent {
				if badge > 0 {
					Text("\(badge)").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				}
			} label: {
				Label(title, systemImage: symbol)
			}
		}
		.listRowSeparator(.hidden)
	}
}
