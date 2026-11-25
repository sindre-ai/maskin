import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The iPad's one navigation: a narrow bar down the left with For you, Chats, Flows and Items and
/// the account at its foot. It drives `AppRuntime.selectedTab`; the tab view beside it only holds
/// each tab's state, with its own bar hidden.
struct ShellRail: View {
	let environment: AppEnvironment
	@Bindable var runtime: AppRuntime
	let badges: ShellBadges
	let switchWorkspace: () -> Void
	@Environment(\.horizontalSizeClass) private var horizontal

	/// Slide Over and a one-third split narrow the rail to icons.
	private var isCompact: Bool { horizontal == .compact }

	var body: some View {
		VStack(spacing: MaskinSpace.s2) {
			VStack(spacing: MaskinSpace.s2) {
				ForEach(ShellTab.primary) { tab in
					ShellRailItem(
						tab: tab, badge: tab.badge(runtime: runtime, badges: badges), isSelected: runtime.selectedTab == tab,
						showsLabel: !isCompact
					) { runtime.selectedTab = tab }
				}
			}
			.accessibilityElement(children: .contain)
			.accessibilityLabel("Destinations")
			Spacer(minLength: 0)
			ShellRailAccount(environment: environment, runtime: runtime, switchWorkspace: switchWorkspace)
		}
		// Clears the status bar when no notice is above the rail.
		.padding(.top, MaskinSpace.s14)
		.padding(.bottom, MaskinSpace.s9)
		.frame(width: isCompact ? Self.compactWidth : Self.width)
		.frame(maxHeight: .infinity)
		.background(MaskinColor.surface.ignoresSafeArea())
		.overlay(alignment: .trailing) { Rectangle().fill(MaskinSurface.line).frame(width: 1).ignoresSafeArea() }
	}

	static let width: CGFloat = 84
	static let compactWidth: CGFloat = 56
}

/// One destination: the icon over its label, filled when selected, with its count at the icon's top right.
private struct ShellRailItem: View {
	let tab: ShellTab
	let badge: TabBadge
	let isSelected: Bool
	let showsLabel: Bool
	let select: () -> Void

	var body: some View {
		Button(action: select) {
			VStack(spacing: MaskinSpace.s1) {
				Image(systemName: tab.systemImage)
					.symbolVariant(isSelected ? .fill : .none)
					.maskinSymbol(22, weight: .regular)
					.frame(width: MaskinSpace.s14, height: MaskinSpace.s12 + MaskinSpace.s2)
					.overlay(alignment: .topTrailing) { RailBadge(badge: badge).offset(x: MaskinSpace.s4, y: -MaskinSpace.s2) }
				if showsLabel {
					Text(tab.title).maskinText(.caption).lineLimit(1)
				}
			}
			.foregroundStyle(isSelected ? MaskinColor.ink : MaskinColor.ink4)
			.frame(width: showsLabel ? Self.width : Self.compactWidth, height: Self.height)
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

	static let width: CGFloat = 68
	static let compactWidth: CGFloat = 48
	static let height: CGFloat = 56
}

struct RailBadge: View {
	let badge: TabBadge

	var body: some View {
		switch badge {
		case .none:
			EmptyView()
		case .dot:
			Circle().fill(MaskinGradient.badgeSolid).frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
		case .count:
			Text(badge.label ?? "")
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.badgeFg)
				.padding(.horizontal, MaskinSpace.s2)
				.frame(minWidth: MaskinSpace.s9, minHeight: MaskinSpace.s9)
				.background(Capsule().fill(MaskinGradient.badgeSolid))
		}
	}
}

/// The avatar at the foot of the rail. It opens a small menu with the name and workspace, Switch
/// workspace and Profile. The menu closes first, then the sheet opens, so the two do not fight.
struct ShellRailAccount: View {
	let environment: AppEnvironment
	let runtime: AppRuntime
	let switchWorkspace: () -> Void
	/// The wide sidebar shows the person's name beside the avatar.
	var showsName = false
	@State private var showMenu = false

	init(environment: AppEnvironment, runtime: AppRuntime, switchWorkspace: @escaping () -> Void, showsName: Bool = false) {
		self.environment = environment
		self.runtime = runtime
		self.switchWorkspace = switchWorkspace
		self.showsName = showsName
	}

	var body: some View {
		if let session = environment.auth.session {
			Button { showMenu = true } label: {
				HStack(spacing: MaskinSpace.s5) {
					ShellNavAvatar(name: session.name, actorID: session.actorId)
						.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
					if showsName {
						Text(session.name).maskinText(.body).foregroundStyle(MaskinColor.ink).lineLimit(1)
						Spacer(minLength: 0)
					}
				}
				.frame(maxWidth: showsName ? .infinity : nil, alignment: .leading)
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityLabel("Account")
			.accessibilityHint("Workspace and profile")
			.popover(isPresented: $showMenu, attachmentAnchor: .rect(.bounds), arrowEdge: .leading) {
				ShellRailMenu(
					name: session.name, workspace: environment.workspaces.selected?.name,
					switchWorkspace: { open(switchWorkspace) }, profile: { open { runtime.showProfile = true } }
				)
				.presentationCompactAdaptation(.popover)
			}
		}
	}

	/// Closes the menu, waits for it to leave, then runs the action.
	private func open(_ action: @escaping () -> Void) {
		showMenu = false
		Task { @MainActor in
			try? await Task.sleep(for: .milliseconds(350))
			action()
		}
	}
}

private struct ShellRailMenu: View {
	let name: String
	let workspace: String?
	let switchWorkspace: () -> Void
	let profile: () -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(name).maskinText(.headline).foregroundStyle(MaskinColor.ink).lineLimit(1)
				Text("Workspace: \(workspace ?? "none")").maskinText(.caption).foregroundStyle(MaskinColor.ink4).lineLimit(1)
			}
			.padding(.horizontal, MaskinSpace.s9)
			.padding(.vertical, MaskinSpace.s7)
			.accessibilityElement(children: .combine)
			Divider()
			row("Switch workspace", detail: workspace, action: switchWorkspace)
			row("Profile", detail: nil, action: profile)
		}
		.frame(width: 280)
	}

	private func row(_ title: String, detail: String?, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			HStack(spacing: MaskinSpace.s5) {
				Text(title).foregroundStyle(MaskinColor.ink)
				Spacer(minLength: MaskinSpace.s5)
				if let detail { Text(detail).foregroundStyle(MaskinColor.ink4).lineLimit(1) }
			}
			.padding(.horizontal, MaskinSpace.s9)
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
	}
}
