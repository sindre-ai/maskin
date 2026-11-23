import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Whether the landscape sidebar shows labels (264 pt) or icons only (72 pt).
///
/// With no chat open the sidebar sits where the person left it. Opening a chat folds it to icons so
/// the thread gets the room. Opening it by hand while a chat is open keeps it open until that chat
/// closes; then it goes back to what it was before the chat.
struct ShellSidebarState: Equatable {
	static let expandedWidth: CGFloat = 264
	static let collapsedWidth: CGFloat = 72

	/// The state with no chat open: what the person last chose.
	private var restingExpanded = true
	/// The state while a chat is open: folded unless the person opened it.
	private var chatExpanded = false
	private(set) var chatOpen = false

	var isExpanded: Bool { chatOpen ? chatExpanded : restingExpanded }
	var width: CGFloat { isExpanded ? Self.expandedWidth : Self.collapsedWidth }

	mutating func setChatOpen(_ open: Bool) {
		guard open != chatOpen else { return }
		chatOpen = open
		chatExpanded = false
	}

	mutating func toggle() {
		if chatOpen { chatExpanded.toggle() } else { restingExpanded.toggle() }
	}
}

/// The iPad's navigation in landscape: For you, Chats, Flows and Items, the workspace and New
/// conversation at the top and the account at the foot. It drives `AppRuntime.selectedTab`; the tab
/// view beside it only holds each tab's state, with its own bar hidden. Portrait and the compact
/// widths keep `ShellRail`.
struct ShellSidebar: View {
	let environment: AppEnvironment
	@Bindable var runtime: AppRuntime
	let badges: ShellBadges
	let isExpanded: Bool
	let toggle: () -> Void
	let switchWorkspace: () -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			workspace
			VStack(spacing: MaskinSpace.s2) {
				ForEach(ShellTab.primary) { tab in
					ShellSidebarItem(
						tab: tab, badge: tab.badge(runtime: runtime, badges: badges), isSelected: runtime.selectedTab == tab,
						isExpanded: isExpanded
					) { runtime.selectedTab = tab }
				}
			}
			.accessibilityElement(children: .contain)
			.accessibilityLabel("Destinations")
			newConversation
			Spacer(minLength: 0)
			footer
		}
		.padding(.horizontal, MaskinSpace.s5)
		// Clears the status bar when no notice is above the sidebar.
		.padding(.top, MaskinSpace.s14)
		.padding(.bottom, MaskinSpace.s9)
		.frame(width: width, alignment: .leading)
		.frame(maxHeight: .infinity)
		.clipped()
		.background(MaskinColor.surface.ignoresSafeArea())
		.overlay(alignment: .trailing) { Rectangle().fill(MaskinSurface.line).frame(width: 1).ignoresSafeArea() }
	}

	private var width: CGFloat {
		isExpanded ? ShellSidebarState.expandedWidth : ShellSidebarState.collapsedWidth
	}

	/// 0.3 s on the app easing. The shell applies it to the sidebar and the screen beside it together.
	static let resize = Animation.timingCurve(0.2, 0.8, 0.2, 1, duration: MaskinDuration.slide)

	/// The current workspace; tapping it opens the switcher.
	private var workspace: some View {
		let name = environment.workspaces.selected?.name
		return Button(action: switchWorkspace) {
			HStack(spacing: MaskinSpace.s5) {
				Text(String((name ?? "M").prefix(1)).uppercased())
					.maskinText(.headline)
					.foregroundStyle(MaskinColor.ink)
					.frame(width: MaskinSpace.s14 + MaskinSpace.s4, height: MaskinSpace.s14 + MaskinSpace.s4)
					.background(
						RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous).fill(MaskinSurface.fill))
				if isExpanded {
					Text(name ?? "Choose workspace").maskinText(.headline).foregroundStyle(MaskinColor.ink).lineLimit(1)
					Spacer(minLength: 0)
					Image(systemName: "chevron.up.chevron.down").maskinSymbol(MaskinFontSize.t13, weight: .semibold)
						.foregroundStyle(MaskinColor.ink4)
				}
			}
			.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin + MaskinSpace.s4, alignment: isExpanded ? .leading : .center)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel("Switch workspace")
		.accessibilityValue(name ?? "")
	}

	/// New conversation; ⌘N is the menu command, so the row only names it.
	private var newConversation: some View {
		Button { runtime.requestNewConversation() } label: {
			HStack(spacing: MaskinSpace.s5) {
				Image(systemName: "plus")
					.maskinSymbol(isExpanded ? 18 : 16, weight: .semibold)
					.foregroundStyle(isExpanded ? MaskinColor.ink : MaskinSurface.onInverse)
					.frame(width: MaskinSpace.s14 + MaskinSpace.s2, height: MaskinSpace.s14 + MaskinSpace.s2)
					.background(Circle().fill(isExpanded ? Color.clear : MaskinSurface.inverse))
				if isExpanded {
					Text("New conversation").maskinText(.body).foregroundStyle(MaskinColor.ink).lineLimit(1)
					Spacer(minLength: 0)
					Text("\u{2318}N").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				}
			}
			.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin, alignment: isExpanded ? .leading : .center)
			.padding(.horizontal, isExpanded ? MaskinSpace.s5 : 0)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel("New conversation")
		.padding(.top, MaskinSpace.s4)
	}

	/// The account, and the button that folds or opens the sidebar.
	@ViewBuilder private var footer: some View {
		VStack(spacing: MaskinSpace.s2) {
			ShellRailAccount(
				environment: environment, runtime: runtime, switchWorkspace: switchWorkspace, showsName: isExpanded)
			Button(action: toggle) {
				HStack(spacing: MaskinSpace.s5) {
					Image(systemName: "sidebar.leading")
						.maskinSymbol(18, weight: .regular)
						.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
					if isExpanded {
						Text("Collapse sidebar").maskinText(.body).lineLimit(1)
						Spacer(minLength: 0)
					}
				}
				.foregroundStyle(MaskinColor.ink4)
				.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin, alignment: isExpanded ? .leading : .center)
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityLabel(isExpanded ? "Collapse sidebar" : "Expand sidebar")
		}
	}
}

/// One destination: the icon, with its name and count beside it when the sidebar is open, and a
/// dot at the icon's top right when it is folded.
private struct ShellSidebarItem: View {
	let tab: ShellTab
	let badge: TabBadge
	let isSelected: Bool
	let isExpanded: Bool
	let select: () -> Void

	var body: some View {
		Button(action: select) {
			HStack(spacing: MaskinSpace.s5) {
				Image(systemName: tab.systemImage)
					.symbolVariant(isSelected ? .fill : .none)
					.maskinSymbol(22, weight: .regular)
					.frame(width: MaskinSpace.s14 + MaskinSpace.s4, height: MaskinSpace.s12 + MaskinSpace.s2)
					.overlay(alignment: .topTrailing) {
						if !isExpanded { RailBadge(badge: badge.asDot).offset(x: MaskinSpace.s2, y: -MaskinSpace.s1) }
					}
				if isExpanded {
					Text(tab.title).maskinText(.body).lineLimit(1)
					Spacer(minLength: MaskinSpace.s3)
					RailBadge(badge: badge)
				}
			}
			.foregroundStyle(isSelected ? MaskinColor.ink : MaskinColor.ink4)
			.padding(.horizontal, isExpanded ? MaskinSpace.s5 : 0)
			.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin + MaskinSpace.s7, alignment: isExpanded ? .leading : .center)
			.background(
				RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
					.fill(isSelected ? MaskinColor.sigTint : Color.clear)
			)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.animation(MaskinMotion.standard, value: isSelected)
		.accessibilityLabel(tab.title)
		.accessibilityValue(badge.spokenValue(needsYou: tab == .forYou) ?? "")
		.accessibilityAddTraits(isSelected ? .isSelected : [])
	}
}

extension TabBadge {
	/// The folded sidebar has no room for a number: any badge shows as a dot.
	var asDot: TabBadge {
		switch self {
		case .none: .none
		case .count, .dot: .dot
		}
	}
}
