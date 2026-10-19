import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// What a root screen adds to the v4 header besides its title and the capsule: whether the capsule
/// carries the account avatar (For you only), and optional chips or a row under the title.
public struct ShellHeaderContent {
	/// True on For you: the avatar opens the profile sheet. Other tabs do not show it.
	public var showsAvatar: Bool
	public var below: AnyView?

	public init<Below: View>(showsAvatar: Bool = false, @ViewBuilder below: () -> Below) {
		self.showsAvatar = showsAvatar
		self.below = AnyView(below())
	}

	public init(showsAvatar: Bool = false) {
		self.showsAvatar = showsAvatar
		self.below = nil
	}
}

/// A filter chip on the dark header: translucent white, solid white when selected.
struct ScreenHeaderChip: View {
	let label: String
	var count: String?
	let selected: Bool
	let action: () -> Void

	var body: some View {
		Button {
			MaskinHaptics.play(.selection)
			action()
		} label: {
			HStack(spacing: MaskinSpace.s3) {
				Text(label).maskinText(.subhead).fontWeight(.semibold)
				if let count {
					Text(count).maskinText(.caption).fontWeight(.bold).monospacedDigit().opacity(0.7)
				}
			}
			.foregroundStyle(selected ? MaskinScreenHeader.inkTop : Color.white)
			.padding(.horizontal, MaskinSpace.s8)
			.frame(height: MaskinSpace.s14 + MaskinSpace.s2)
			.background(Capsule().fill(selected ? Color.white : MaskinScreenHeader.buttonFill))
			.overlay(Capsule().strokeBorder(MaskinScreenHeader.buttonRing, lineWidth: selected ? 0 : 1))
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel(count.map { "\(label), \($0)" } ?? label)
		.accessibilityAddTraits(selected ? .isSelected : [])
	}
}

/// The row of chips under the title: scrolls sideways, bleeds to the screen edges.
struct ScreenHeaderChipRow<Content: View>: View {
	@ViewBuilder var content: Content

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s4) { content }
				.padding(.horizontal, MaskinSpace.s9)
		}
		.scrollClipDisabled()
	}
}

/// A header on the dark teal gradient with the content on a rounded sheet that rides up over the
/// header's bottom edge. The header is whatever the screen puts in `header`; this draws the gradient,
/// the room under it and the sheet.
struct ScreenHeaderSheet<Header: View, Content: View>: View {
	let header: Header
	let content: Content

	init(@ViewBuilder header: () -> Header, @ViewBuilder content: () -> Content) {
		self.header = header()
		self.content = content()
	}

	var body: some View {
		VStack(spacing: -MaskinScreenHeader.overlap) {
			header
				.padding(.top, MaskinSpace.s4)
				// Room for the sheet to ride up over this edge.
				.padding(.bottom, MaskinSpace.s12 + MaskinScreenHeader.overlap)
				.frame(maxWidth: .infinity, alignment: .leading)
				.background { MaskinScreenHeader.gradient.ignoresSafeArea(edges: .top) }
				.environment(\.colorScheme, .dark)
			content
				.frame(maxWidth: .infinity, maxHeight: .infinity)
				.background(MaskinScreenHeader.sheet)
				.clipShape(
					UnevenRoundedRectangle(
						topLeadingRadius: MaskinScreenHeader.sheetRadius,
						topTrailingRadius: MaskinScreenHeader.sheetRadius))
		}
	}
}

/// The v4 root-screen header on iPhone: kicker and buttons on one row, then the large title.
struct ShellHeaderView: View {
	let environment: AppEnvironment
	let title: String
	let content: ShellHeaderContent
	let actions: ShellActions
	let showsAvatar: Bool
	let openSearch: () -> Void
	let openProfile: () -> Void
	let openLive: () -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			HStack {
				Spacer(minLength: 0)
				capsule
			}
			.padding(.horizontal, MaskinSpace.s9)
			Text(title)
				.maskinText(.largeTitle)
				.foregroundStyle(.white)
				.lineLimit(1)
				.minimumScaleFactor(0.7)
				.padding(.horizontal, MaskinSpace.s11)
				.accessibilityAddTraits(.isHeader)
			if let below = content.below { below.padding(.top, MaskinSpace.s5) }
		}
	}

	/// One glass capsule at the top right: Display on every tab, then Live (For you), the avatar
	/// (For you) or New (Team).
	private var capsule: some View {
		HStack(spacing: 0) {
			if let display = actions.display {
				Menu {
					display.content
				} label: {
					CapsuleDisc(symbol: ShellActions.slidersSymbol, marked: actions.displayActive)
				}
				.accessibilityLabel(actions.displayActive ? "Display, options changed" : "Display")
			}
			if actions.live {
				Button(action: openLive) {
					CapsuleDisc(symbol: "waveform", prominent: true)
				}
				.buttonStyle(.plain)
				.accessibilityLabel(LiveMeetingRequest.dailyBriefing.buttonLabel)
			}
			if showsAvatar, content.showsAvatar {
				Button(action: openProfile) {
					ShellNavAvatar(name: environment.auth.session?.name ?? "")
						.frame(width: MaskinScreenHeader.discSize, height: MaskinScreenHeader.discSize)
						.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
						.contentShape(Circle())
				}
				.buttonStyle(.plain)
				.accessibilityLabel("Account")
			}
			if let new = actions.new {
				Button(action: new) {
					CapsuleDisc(symbol: "plus", prominent: true)
				}
				.buttonStyle(.plain)
				.accessibilityLabel(actions.newLabel)
			}
		}
		.padding(.horizontal, MaskinSpace.s1)
		.frame(height: MaskinScreenHeader.capsuleHeight)
		.background(Capsule().fill(MaskinScreenHeader.buttonFill))
		.overlay(Capsule().strokeBorder(MaskinScreenHeader.capsuleRing, lineWidth: 1))
	}
}

/// One 44pt hit area in the capsule with a 36pt disc: solid white for a primary action, plain glyph
/// otherwise. A changed Display setting fills the Display disc.
private struct CapsuleDisc: View {
	let symbol: String
	var prominent = false
	var marked = false

	var body: some View {
		Image(systemName: symbol)
			.maskinSymbol(16, weight: .semibold)
			// The glyph lives in a fixed disc, so it must not grow past it with Dynamic Type.
			.dynamicTypeSize(...DynamicTypeSize.large)
			.foregroundStyle(prominent || marked ? MaskinScreenHeader.inkTop : .white)
			.frame(width: MaskinScreenHeader.discSize, height: MaskinScreenHeader.discSize)
			.background(
				Circle().fill(
					prominent ? Color.white : (marked ? MaskinScreenHeader.kicker : Color.clear))
			)
			.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
			.contentShape(Circle())
	}
}

extension View {
	/// A pushed screen whose top is the v4 gradient: the system bar keeps its buttons, clear over the
	/// gradient, with light content.
	func onHeaderGradientBar() -> some View {
		#if os(iOS)
			return
				self
				.toolbarBackground(.hidden, for: .navigationBar)
				.toolbarColorScheme(.dark, for: .navigationBar)
		#else
			return self
		#endif
	}
}
