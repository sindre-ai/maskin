import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The profile sheet the avatar opens on every root tab (large detent): who is signed in (tap for
/// Your profile), the workspace with Switch, the WORKSPACE and YOU groups, and Log out. Replaces the
/// More tab.
///
/// Profile pushes onto the sheet's own stack. Every other row opens the existing screen as a second
/// sheet over this one, because those screens own a `NavigationStack` (or split view) and a Done
/// button and cannot be pushed into another stack.
struct ProfileSheet: View {
	let environment: AppEnvironment
	@Bindable var runtime: AppRuntime
	@State private var destination: Destination?
	@State private var confirmSignOut = false
	@Environment(\.dismiss) private var dismiss

	private enum Destination: Hashable, Identifiable {
		case item(ProfileMenuItem)
		case workspaces
		var id: Self { self }
	}

	private enum Route: Hashable { case yourProfile }

	private var hasWorkspace: Bool { environment.workspaceId != nil }

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(spacing: MaskinSpace.gapSection) {
					profileCard
					workspaceCard
					ForEach(ProfileMenuGroup.allCases) { group in
						let items = ProfileMenu.items(in: group, hasWorkspace: hasWorkspace)
						if !items.isEmpty {
							groupLabel(group.title)
							card(items)
						}
					}
					signOutCard
					versionFooter
				}
				.padding(.horizontal, MaskinSpace.s9)
				.padding(.vertical, MaskinSpace.s9)
			}
			.ambientBackground()
			.foregroundStyle(MaskinColor.ink)
			.navigationTitle("Profile")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
			}
			.navigationDestination(for: Route.self) { _ in
				YourProfilePage(environment: environment)
			}
			// Signing out discards writes still waiting to send, so ask first (Settings does too).
			.confirmationDialog("Log out of Maskin?", isPresented: $confirmSignOut, titleVisibility: .visible) {
				Button("Log out", role: .destructive) { Task { await runtime.signOut() } }
			} message: {
				Text("Anything still waiting to send will be discarded.")
			}
			.sheet(item: $destination) { destination in
				destinationContent(destination)
					.environment(\.shellShowsAvatar, false)
			}
		}
		.presentationDetents([.large])
		.environment(\.shellShowsAvatar, false)
	}

	// MARK: Destinations

	@ViewBuilder
	private func destinationContent(_ destination: Destination) -> some View {
		switch destination {
		case .workspaces:
			// Picking a workspace resets the app to For you and closes this sheet (`AppRuntime.sync`).
			WorkspaceSwitcher(environment: environment)
				.presentationDetents([.medium, .large])
		case .item(.agents):
			AgentsScreen(environment: environment)
		case .item(.marketplace):
			if let workspaceID = environment.workspaceId {
				MarketplaceSheet(
					environment: environment, workspaceID: workspaceID,
					onOpenLoop: { _ in
						runtime.presentation = nil
						runtime.selectedTab = .loops
					})
			}
		case .item(.artefacts):
			FilesListScreen(environment: environment, onDone: { self.destination = nil })
		case .item(.settings):
			SettingsScreen(environment: environment)
		case .item(.notifications):
			NotificationsScreen(environment: environment, store: runtime.notifications)
				.environment(runtime.router)
				.task { await runtime.requestPushPermission() }
		case .item(.triggers):
			if let workspaceID = environment.workspaceId {
				TriggersSheet(environment: environment, workspaceID: workspaceID)
			}
		}
	}

	// MARK: Cards

	/// Who is signed in; tap for Your profile.
	@ViewBuilder private var profileCard: some View {
		if let session = environment.auth.session {
			NavigationLink(value: Route.yourProfile) {
				HStack(spacing: MaskinSpace.s8) {
					ActorAvatar(name: session.name, kind: .human, size: MaskinSpace.s14 + MaskinSpace.s12)
					VStack(alignment: .leading, spacing: MaskinSpace.s1) {
						Text(session.name).maskinText(.headline).foregroundStyle(MaskinColor.ink)
						if let email = session.email {
							Text(email).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
								.lineLimit(1)
						}
					}
					Spacer(minLength: MaskinSpace.s4)
					Image(systemName: "chevron.right")
						.font(.system(size: MaskinSpace.s7, weight: .semibold))
						.foregroundStyle(MaskinColor.ink5)
						.accessibilityHidden(true)
				}
				.padding(MaskinSpace.s9)
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityLabel("Your profile, \(session.name)")
			.profileCard()
		}
	}

	/// The workspace you are working in, with Switch.
	private var workspaceCard: some View {
		HStack(spacing: MaskinSpace.s8) {
			ProfileTile(symbol: "square.stack.3d.up")
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text("Workspace").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				Text(environment.workspaces.selected?.name ?? "Choose workspace")
					.maskinText(.body).foregroundStyle(MaskinColor.ink).lineLimit(1)
			}
			Spacer(minLength: MaskinSpace.s4)
			Button("Switch") { destination = .workspaces }
				.buttonStyle(.bordered)
				.controlSize(.small)
		}
		.padding(.horizontal, MaskinSpace.s9)
		.padding(.vertical, MaskinSpace.s5)
		.frame(minHeight: MaskinSpace.touchMin)
		.profileCard()
	}

	private func card(_ items: [ProfileMenuItem]) -> some View {
		VStack(spacing: 0) {
			ForEach(Array(items.enumerated()), id: \.element) { index, item in
				if index > 0 { separator() }
				ProfileRow(
					title: item.title, symbol: item.symbol,
					badge: item == .notifications ? runtime.notifications.unreadCount : 0
				) { destination = .item(item) }
			}
		}
		.profileCard()
	}

	private func groupLabel(_ text: String) -> some View {
		Text(text)
			.maskinText(.microLabel)
			.textCase(.uppercase)
			.foregroundStyle(MaskinColor.ink4)
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.horizontal, MaskinSpace.s4)
			.accessibilityAddTraits(.isHeader)
	}

	private var signOutCard: some View {
		Button(role: .destructive) {
			confirmSignOut = true
		} label: {
			Label("Log out", systemImage: "rectangle.portrait.and.arrow.right")
				.maskinText(.body)
				.foregroundStyle(MaskinColor.danger)
				.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
				.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.profileCard()
	}

	/// The build that is running, so a tester can say which one they are looking at.
	@ViewBuilder private var versionFooter: some View {
		if let version = Self.versionText {
			Text(version)
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.ink5)
				.frame(maxWidth: .infinity)
				.padding(.top, MaskinSpace.s4)
		}
	}

	private static var versionText: String? {
		let info = Bundle.main.infoDictionary
		guard let short = info?["CFBundleShortVersionString"] as? String else { return nil }
		guard let build = info?["CFBundleVersion"] as? String else { return "Maskin \(short)" }
		return "Maskin \(short) (\(build))"
	}

	private func separator() -> some View {
		Rectangle()
			.fill(MaskinSurface.separator)
			.frame(height: 1)
			.padding(.leading, MaskinSpace.s9 + ProfileTile.size + MaskinSpace.s8)
	}
}

extension ProfileMenuItem {
	fileprivate var symbol: String {
		switch self {
		case .agents: "person.2"
		case .marketplace: "square.grid.2x2"
		case .artefacts: "doc.text"
		case .settings: "gearshape"
		case .notifications: "bell"
		case .triggers: "bolt"
		}
	}
}

/// Your profile, pushed onto the profile sheet's stack.
private struct YourProfilePage: View {
	@State private var store: ProfileStore

	init(environment: AppEnvironment) {
		_store = State(initialValue: SettingsServices(environment: environment).profileStore())
	}

	var body: some View { ProfileView(store: store) }
}

/// A neutral icon tile.
private struct ProfileTile: View {
	static let size: CGFloat = MaskinSpace.s14
	let symbol: String

	var body: some View {
		Image(systemName: symbol)
			.font(.system(size: MaskinSpace.s10, weight: .semibold))
			.foregroundStyle(MaskinColor.ink2)
			.frame(width: Self.size, height: Self.size)
			.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.btn, style: .continuous))
			.accessibilityHidden(true)
	}
}

/// One row: an icon tile, a title, an optional unread pill and a chevron.
private struct ProfileRow: View {
	let title: String
	let symbol: String
	var badge: Int = 0
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			HStack(spacing: MaskinSpace.s8) {
				ProfileTile(symbol: symbol)
				Text(title).maskinText(.body).foregroundStyle(MaskinColor.ink).lineLimit(1)
				Spacer(minLength: MaskinSpace.s4)
				if badge > 0 { UnreadBadge(count: badge) }
				Image(systemName: "chevron.right")
					.font(.system(size: MaskinSpace.s7, weight: .semibold))
					.foregroundStyle(MaskinColor.ink5)
					.accessibilityHidden(true)
			}
			.padding(.horizontal, MaskinSpace.s9)
			.padding(.vertical, MaskinSpace.s5)
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
	}
}

extension View {
	/// A grouped card on the iOS canvas: card surface, continuous corners, hairline border.
	fileprivate func profileCard() -> some View {
		background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
			.overlay(
				RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
					.strokeBorder(MaskinSurface.line, lineWidth: 1)
			)
			.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
	}
}
