import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// What the iPad's bottom bar looks like right now.
enum PadBarShape: Equatable {
	/// Icon and label for each destination, plus the New conversation button.
	case full
	/// Icons only, centred under the chat list, while a chat is open beside it.
	case compact
	/// Away: a detail screen, a sheet or the New conversation form is on screen.
	case hidden
}

/// When the iPad has a bottom bar, and which shape it takes. Pure, so it is tested without a screen.
enum PadBarLayout {
	/// Portrait at regular width draws the bar in place of the left rail. Landscape keeps the rail,
	/// and Slide Over or a one-third split (compact width) keeps its narrow rail.
	static func usesBottomBar(portrait: Bool, regularWidth: Bool) -> Bool { portrait && regularWidth }

	static func shape(tab: ShellTab, chatOpen: Bool, covered: Bool) -> PadBarShape {
		if covered { return .hidden }
		return tab == .chats && chatOpen ? .compact : .full
	}

	/// The compact bar centres under the list column, which is as wide as the portrait list.
	static let compactColumnWidth = ChatsPadLayout.portraitListWidth
	/// The compact bar's capsule height, and its round targets inside.
	static let compactHeight = MaskinSpace.touchMin + MaskinSpace.s9
	static let compactTarget = MaskinSpace.touchMin + MaskinSpace.s2
	/// How far both shapes float above the bottom edge.
	static let bottomGap = MaskinSpace.s11 + MaskinSpace.s1
	/// Room a screen leaves at its foot so the bar does not sit on its content.
	static let reserve = compactHeight + bottomGap
}

/// The iPad's own bottom bar for portrait: For you, Chats, Flows and Items, drawn here because the
/// system tab bar cannot sit under one column. It drives `AppRuntime.selectedTab` like the rail.
struct PadBottomBar: View {
	let shape: PadBarShape
	let selected: ShellTab
	let badge: (ShellTab) -> TabBadge
	let select: (ShellTab) -> Void
	let newConversation: () -> Void
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	var body: some View {
		ZStack(alignment: .bottom) {
			switch shape {
			case .full:
				fullBar.transition(.opacity)
			case .compact:
				compactBar
					.frame(width: PadBarLayout.compactColumnWidth)
					.frame(maxWidth: .infinity, alignment: .leading)
					.transition(.opacity)
			case .hidden:
				EmptyView()
			}
		}
		.padding(.bottom, PadBarLayout.bottomGap)
		// A cross-fade between the two shapes; Reduce Motion swaps them at once.
		.animation(reduceMotion ? nil : MaskinMotion.fade, value: shape)
	}

	private var fullBar: some View {
		HStack(spacing: MaskinSpace.s4) {
			HStack(spacing: MaskinSpace.s1) {
				ForEach(ShellTab.primary) { tab in
					PadBarFullItem(
						tab: tab, badge: badge(tab), isSelected: selected == tab, select: { select(tab) })
				}
			}
			.padding(MaskinSpace.s2)
			.maskinGlassCapsule(interactive: true)
			.accessibilityElement(children: .contain)
			.accessibilityLabel("Destinations")
			Button(action: newConversation) {
				ShellInkCircle(symbol: "plus", label: "New conversation", filled: true)
			}
			.buttonStyle(.plain)
		}
	}

	private var compactBar: some View {
		HStack(spacing: 0) {
			ForEach(ShellTab.primary) { tab in
				PadBarCompactItem(
					tab: tab, badge: badge(tab), isSelected: selected == tab, select: { select(tab) })
			}
		}
		.padding(.horizontal, MaskinSpace.s3)
		.frame(height: PadBarLayout.compactHeight)
		.maskinGlassCapsule(interactive: true)
		.accessibilityElement(children: .contain)
		.accessibilityLabel("Destinations")
	}
}

/// One destination in the full bar: the icon over its label, filled when selected, count at the icon's top right.
private struct PadBarFullItem: View {
	let tab: ShellTab
	let badge: TabBadge
	let isSelected: Bool
	let select: () -> Void

	var body: some View {
		Button(action: select) {
			VStack(spacing: MaskinSpace.s1) {
				Image(systemName: tab.systemImage)
					.symbolVariant(isSelected ? .fill : .none)
					.maskinSymbol(22, weight: .regular)
					.frame(width: MaskinSpace.s14, height: MaskinSpace.s12 + MaskinSpace.s2)
					.overlay(alignment: .topTrailing) {
						RailBadge(badge: badge).offset(x: MaskinSpace.s4, y: -MaskinSpace.s2)
					}
				Text(tab.title).maskinText(.caption).lineLimit(1)
			}
			.foregroundStyle(isSelected ? MaskinColor.ink : MaskinColor.ink4)
			.frame(width: Self.width, height: Self.height)
			.background(
				RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
					.fill(isSelected ? MaskinColor.sigTint : Color.clear))
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel(tab.title)
		.accessibilityValue(badge.spokenValue(needsYou: tab == .forYou) ?? "")
		.accessibilityAddTraits(isSelected ? .isSelected : [])
	}

	static let width: CGFloat = 76
	static let height: CGFloat = 56
}

/// One destination in the compact bar: an icon in a 48 pt round target. The selected one has a white
/// fill and a hairline ring; an unread destination has a dot at the icon's top right.
private struct PadBarCompactItem: View {
	let tab: ShellTab
	let badge: TabBadge
	let isSelected: Bool
	let select: () -> Void

	var body: some View {
		Button(action: select) {
			Image(systemName: tab.systemImage)
				.symbolVariant(isSelected ? .fill : .none)
				.maskinSymbol(22, weight: .regular)
				.foregroundStyle(isSelected ? MaskinColor.ink : MaskinColor.ink4)
				.frame(width: PadBarLayout.compactTarget, height: PadBarLayout.compactTarget)
				.background(Circle().fill(isSelected ? MaskinSurface.card : Color.clear))
				.overlay(Circle().strokeBorder(isSelected ? MaskinSurface.line : Color.clear, lineWidth: 1))
				.overlay(alignment: .topTrailing) {
					if badge != .none {
						Circle().fill(MaskinGradient.badgeSolid)
							.frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
							.padding(MaskinSpace.s3)
					}
				}
				.contentShape(Circle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel(tab.title)
		.accessibilityValue(badge.spokenValue(needsYou: tab == .forYou) ?? "")
		.accessibilityAddTraits(isSelected ? .isSelected : [])
	}
}

extension View {
	/// While this view is on screen (and `active`), the iPad's bottom bar steps aside. For a screen
	/// pushed over a tab's root, or a sheet the screen opens itself.
	func hidesPadBar(_ active: Bool = true) -> some View {
		modifier(HidesPadBar(active: active))
	}
}

private struct HidesPadBar: ViewModifier {
	let active: Bool
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var token = UUID()

	func body(content: Content) -> some View {
		content
			.onAppear { update() }
			.onChange(of: active) { update() }
			.onDisappear { runtime?.padBarHiders.remove(token) }
	}

	private func update() {
		if active { runtime?.padBarHiders.insert(token) } else { runtime?.padBarHiders.remove(token) }
	}
}
