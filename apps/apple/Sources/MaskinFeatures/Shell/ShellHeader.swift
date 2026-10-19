import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The words in a root screen's header: the kicker above the title, and optional filter chips
/// under it (`ScreenHeaderChip`s in a `ScreenHeaderChipRow`).
public struct ShellHeaderContent {
	public var kicker: String
	public var chips: AnyView?

	public init<Chips: View>(kicker: String, @ViewBuilder chips: () -> Chips) {
		self.kicker = kicker
		self.chips = AnyView(chips())
	}

	public init(kicker: String) {
		self.kicker = kicker
		self.chips = nil
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

/// The v4 root-screen header on iPhone: kicker and buttons on one row, then the large title, on the dark teal gradient. The content that follows rides up over its bottom edge.
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
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			VStack(alignment: .leading, spacing: MaskinSpace.s7) {
				HStack(spacing: MaskinSpace.s4) {
					Text(content.kicker)
						.maskinText(.microLabelLarge)
						.foregroundStyle(MaskinScreenHeader.kicker)
						.lineLimit(1)
					Spacer(minLength: MaskinSpace.s4)
					buttons
				}
				Text(title)
					.maskinText(.largeTitle)
					.foregroundStyle(.white)
					.lineLimit(1)
					.minimumScaleFactor(0.7)
					.accessibilityAddTraits(.isHeader)
			}
			.padding(.horizontal, MaskinSpace.s9)
			if let chips = content.chips { chips }
		}
		.padding(.top, MaskinSpace.s4)
		// Room for the sheet to ride up over this edge.
		.padding(.bottom, MaskinSpace.s12 + MaskinScreenHeader.overlap)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background { MaskinScreenHeader.gradient.ignoresSafeArea(edges: .top) }
		.environment(\.colorScheme, .dark)
	}

	@ViewBuilder private var buttons: some View {
		HStack(spacing: MaskinSpace.s4) {
			if actions.live {
				HeaderButton(symbol: "waveform", label: LiveMeetingRequest.dailyBriefing.buttonLabel, prominent: true, action: openLive)
			}
			if let new = actions.new {
				HeaderButton(symbol: "plus", label: actions.newLabel, prominent: true, action: new)
			}
			HeaderButton(symbol: "magnifyingglass", label: "Search", action: openSearch)
			if let display = actions.display {
				Menu {
					display.content
				} label: {
					HeaderDisc(symbol: actions.displaySymbol, marked: actions.displayActive)
				}
				.accessibilityLabel(actions.displayActive ? "Display, options changed" : "Display")
			} else if let toggle = actions.displayToggle {
				HeaderButton(
					symbol: actions.displaySymbol, label: actions.displayActive ? "Filter, shown" : "Filter",
					marked: actions.displayActive, action: toggle)
			}
			if showsAvatar {
				Button(action: openProfile) {
					ShellNavAvatar(name: environment.auth.session?.name ?? "")
						.frame(width: MaskinScreenHeader.buttonSize, height: MaskinScreenHeader.buttonSize)
						.contentShape(Circle())
				}
				.buttonStyle(.plain)
				.accessibilityLabel("Account")
			}
		}
	}
}

/// A 40pt circle in the header: translucent white, or solid white for a primary action.
private struct HeaderDisc: View {
	let symbol: String
	var prominent = false
	var marked = false

	var body: some View {
		Image(systemName: symbol)
			.maskinSymbol(16, weight: .semibold)
			// The glyph lives in a fixed 40pt disc, so it must not grow past it with Dynamic Type.
			.dynamicTypeSize(...DynamicTypeSize.large)
			.foregroundStyle(prominent ? MaskinScreenHeader.inkTop : .white)
			.frame(width: MaskinScreenHeader.buttonSize, height: MaskinScreenHeader.buttonSize)
			.background(Circle().fill(prominent ? Color.white : MaskinScreenHeader.buttonFill))
			.overlay(Circle().strokeBorder(MaskinScreenHeader.buttonRing, lineWidth: 1))
			.overlay(alignment: .topTrailing) {
				if marked {
					Circle().fill(MaskinScreenHeader.glow)
						.frame(width: MaskinScreenHeader.dotSize, height: MaskinScreenHeader.dotSize)
				}
			}
			.contentShape(Circle())
	}
}

private struct HeaderButton: View {
	let symbol: String
	let label: String
	var prominent = false
	var marked = false
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			HeaderDisc(symbol: symbol, prominent: prominent, marked: marked)
		}
		.buttonStyle(.plain)
		.accessibilityLabel(label)
	}
}
