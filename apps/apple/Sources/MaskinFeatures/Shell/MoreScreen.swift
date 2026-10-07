import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The More tab: who is signed in, the workspace, the places that don't have a tab, settings and
/// sign out. Replaces the account button that used to sit in every screen's toolbar.
///
/// Laid out as grouped cards on the iOS canvas: a profile card (with the workspace switcher
/// inside it), a card for the places you go to, a card for settings, and sign out on its own so
/// it is never next to something you tap often.
struct MoreScreen: View {
	let environment: AppEnvironment
	@Bindable var runtime: AppRuntime
	@State private var showWorkspaces = false
	@State private var showMarketplace = false
	@State private var confirmSignOut = false
	@State private var settingsRoute: SettingsRoute?
	@Environment(\.horizontalSizeClass) private var sizeClass

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(spacing: MaskinSpace.gapSection) {
					profileCard
					workspaceCard
					groupLabel("Workspace")
					placesCard
					groupLabel("Settings")
					settingsCard
					signOutCard
					versionFooter
				}
				.padding(.horizontal, MaskinSpace.s9)
				.padding(.vertical, MaskinSpace.s9)
			}
			.ambientBackground()
			.foregroundStyle(MaskinColor.ink)
			.shellToolbar(environment: environment, title: "More", actions: ShellActions(search: false))
			// Signing out discards writes still waiting to send, so ask first (Settings does too).
			.confirmationDialog("Log out of Maskin?", isPresented: $confirmSignOut, titleVisibility: .visible) {
				Button("Log out", role: .destructive) { Task { await runtime.signOut() } }
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
			.sheet(item: $settingsRoute) { route in
				SettingsScreen(environment: environment, initialRoute: route)
			}
			.sheet(isPresented: $showWorkspaces) {
				WorkspaceSwitcher(environment: environment)
					.presentationDetents([.medium, .large])
			}
		}
	}

	// MARK: Cards

	/// Who is signed in, and the workspace they are working in with a way to change it.
	private var profileCard: some View {
		VStack(spacing: 0) {
			if let session = environment.auth.session {
				HStack(spacing: MaskinSpace.s8) {
					ActorAvatar(name: session.name, kind: .human, size: MaskinSpace.s14 + MaskinSpace.s12)
					VStack(alignment: .leading, spacing: MaskinSpace.s1) {
						Text(session.name).maskinText(.headline).foregroundStyle(MaskinColor.ink)
						if let email = session.email {
							Text(email).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
								.lineLimit(1)
						}
					}
					Spacer(minLength: 0)
				}
				.padding(MaskinSpace.s9)
				.accessibilityElement(children: .combine)
			}
		}
		.moreCard()
	}

	/// The workspace you are working in, with a way to change it.
	private var workspaceCard: some View {
		MoreRow(
			title: environment.workspaces.selected?.name ?? "Choose workspace",
			caption: "Workspace", symbol: "square.stack.3d.up",
			tint: MaskinColor.warningTint, tone: MaskinColor.warningStrong
		) { showWorkspaces = true }
		.moreCard()
	}

	/// The workspace's places that don't have a tab of their own.
	private var placesCard: some View {
		VStack(spacing: 0) {
			MoreRow(
				title: "Artefacts", subtitle: "Pages and PDFs your agents made", symbol: "doc.text",
				tint: MaskinColor.infoTint, tone: MaskinColor.infoStrong
			) { runtime.showFiles = true }
			if sizeClass == .compact {
				separator()
				MoreRow(
					title: "Agents", subtitle: "Who works for you", symbol: "person.2",
					tint: MaskinColor.agentRelayTint, tone: MaskinColor.agentRelayFg
				) { runtime.showAgents = true }
			}
			if environment.workspaceId != nil {
				separator()
				MoreRow(
					title: "Marketplace", subtitle: "Loops to install", symbol: "square.grid.2x2",
					tint: MaskinColor.successTint, tone: MaskinColor.successStrong
				) { showMarketplace = true }
			}
		}
		.moreCard()
	}

	/// Notifications, then the settings pages people reach for most; each opens that page with
	/// Settings behind it.
	private var settingsCard: some View {
		VStack(spacing: 0) {
			MoreRow(
				title: "Notifications", symbol: "bell",
				tint: MaskinSurface.fill, tone: MaskinColor.ink2,
				badge: runtime.notifications.unreadCount
			) { runtime.showNotifications = true }
			if environment.workspaceId != nil {
				separator()
				MoreRow(
					title: "Members", symbol: "person.2.circle",
					tint: MaskinColor.surfaceStrong, tone: MaskinColor.ink2
				) { settingsRoute = .members }
				separator()
				MoreRow(
					title: "Integrations", symbol: "link",
					tint: MaskinColor.surfaceStrong, tone: MaskinColor.ink2
				) { settingsRoute = .integrations }
				separator()
				MoreRow(
					title: "Billing", symbol: "creditcard",
					tint: MaskinColor.surfaceStrong, tone: MaskinColor.ink2
				) { settingsRoute = .billing }
			}
			separator()
			MoreRow(
				title: "Keys", symbol: "key",
				tint: MaskinColor.surfaceStrong, tone: MaskinColor.ink2
			) { settingsRoute = .apiKey }
			separator()
			MoreRow(
				title: "All settings", symbol: "gearshape",
				tint: MaskinColor.surfaceStrong, tone: MaskinColor.ink2
			) { runtime.showSettings = true }
		}
		.moreCard()
	}

	private func groupLabel(_ text: String) -> some View {
		Text(text)
			.maskinText(.microLabel)
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
		.moreCard()
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

	private func separator(inset: CGFloat = MaskinSpace.s9 + MoreRow.tileSize + MaskinSpace.s8) -> some View {
		Rectangle()
			.fill(MaskinSurface.separator)
			.frame(height: 1)
			.padding(.leading, inset)
	}
}

/// One row: a tinted icon tile, a title, an optional unread pill and a chevron.
private struct MoreRow: View {
	static let tileSize: CGFloat = MaskinSpace.s14

	let title: String
	var caption: String?
	var subtitle: String?
	let symbol: String
	let tint: Color
	let tone: Color
	var badge: Int = 0
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			HStack(spacing: MaskinSpace.s8) {
				Image(systemName: symbol)
					.font(.system(size: MaskinSpace.s10, weight: .semibold))
					.foregroundStyle(tone)
					.frame(width: Self.tileSize, height: Self.tileSize)
					.background(tint, in: RoundedRectangle(cornerRadius: MaskinRadius.btn, style: .continuous))
					.accessibilityHidden(true)
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					if let caption {
						Text(caption).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
					}
					Text(title).maskinText(.body).foregroundStyle(MaskinColor.ink)
						.lineLimit(1)
					if let subtitle {
						Text(subtitle).maskinText(.caption).foregroundStyle(MaskinColor.ink4).lineLimit(1)
					}
				}
				Spacer(minLength: MaskinSpace.s4)
				if badge > 0 {
					UnreadBadge(count: badge)
				}
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
	fileprivate func moreCard() -> some View {
		background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
			.overlay(
				RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
					.strokeBorder(MaskinSurface.line, lineWidth: 1)
			)
			.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
	}
}
