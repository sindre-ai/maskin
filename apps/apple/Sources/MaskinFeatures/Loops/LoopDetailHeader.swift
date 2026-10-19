import MaskinCore
import MaskinDesign
import SwiftUI

/// The flow detail's header on iPhone, on the teal gradient: the flow's name and state, three
/// numbers, and the tab switcher. The system bar above it keeps the back button and the gear.
struct LoopDetailHeader: View {
	let loop: LoopSummary
	@Binding var tab: LoopDetailTab
	/// "Under the hood" replaces the tabs, so the switcher is hidden.
	let showsTabs: Bool

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s8) {
			VStack(alignment: .leading, spacing: MaskinSpace.s3) {
				Text("\(loop.cycleLabel) · \(loop.pill.label)".uppercased())
					.maskinText(.microLabelLarge)
					.foregroundStyle(MaskinScreenHeader.kicker)
					.lineLimit(1)
				Text(loop.displayName)
					.maskinText(.title)
					.foregroundStyle(.white)
					.fixedSize(horizontal: false, vertical: true)
					.accessibilityAddTraits(.isHeader)
			}
			HStack(alignment: .top, spacing: MaskinSpace.s4) {
				stat(loop.waitingCount, "Waiting on you")
				stat(loop.inProgressCount, "In progress")
				stat(loop.closedCount, "Closed")
			}
			if showsTabs { tabs }
		}
		.padding(.horizontal, MaskinSpace.s9)
	}

	private func stat(_ value: Int, _ label: String) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s1) {
			Text("\(value)")
				.font(MaskinTypeface.sans(MaskinFontSize.t24, weight: .heavy, relativeTo: .title2))
				.monospacedDigit()
				.foregroundStyle(.white)
			Text(label)
				.maskinText(.caption)
				.foregroundStyle(MaskinScreenHeader.kicker)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.accessibilityElement(children: .combine)
	}

	/// Outcome / Actions / Activity as a capsule switcher: the chosen one is solid white.
	private var tabs: some View {
		HStack(spacing: MaskinSpace.s1) {
			ForEach(LoopDetailTab.allCases) { item in
				let selected = tab == item
				Button {
					MaskinHaptics.play(.selection)
					withAnimation(MaskinMotion.quick) { tab = item }
				} label: {
					Text(item.rawValue)
						.maskinText(.subhead)
						.fontWeight(.semibold)
						.foregroundStyle(selected ? MaskinScreenHeader.inkTop : .white)
						.frame(maxWidth: .infinity, minHeight: MaskinSpace.s14 + MaskinSpace.s2)
						.background(Capsule().fill(selected ? Color.white : Color.clear))
						.contentShape(Capsule())
				}
				.buttonStyle(.plain)
				.accessibilityAddTraits(selected ? .isSelected : [])
			}
		}
		.padding(MaskinSpace.s1 + MaskinSpace.s1)
		.background(Capsule().fill(MaskinScreenHeader.buttonFill))
	}
}
