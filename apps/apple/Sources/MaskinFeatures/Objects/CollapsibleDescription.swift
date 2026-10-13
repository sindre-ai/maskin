import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// An object's description as rendered markdown. Past `DescriptionCollapse.characterThreshold`
/// it folds to `collapsedHeight` under a fade with "Read all · N min"; expanded, it shows the
/// whole thing with "Show less". Lines are never truncated: the fold clips the block, not a line.
struct CollapsibleDescription: View {
	let content: String
	/// Starts open (snapshots, previews). The reader's toggle wins afterwards.
	var initiallyExpanded = false

	@State private var expanded: Bool?
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	static let collapsedHeight: CGFloat = 240
	private static let fadeHeight: CGFloat = 72

	private var folds: Bool { DescriptionCollapse.collapses(content) }
	private var isCollapsed: Bool { folds && !(expanded ?? initiallyExpanded) }

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			MarkdownContent(content, style: .description)
				.fixedSize(horizontal: false, vertical: true)
				.frame(maxHeight: isCollapsed ? Self.collapsedHeight : nil, alignment: .top)
				.clipped()
				.mask(alignment: .top) {
					if isCollapsed {
						VStack(spacing: 0) {
							Color.black
							LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
								.frame(height: Self.fadeHeight)
						}
					} else {
						Color.black
					}
				}
				.accessibilityHint(isCollapsed ? "Folded. Read all shows the rest." : "")
			if folds {
				Button {
					MaskinHaptics.play(.selection)
					withAnimation(reduceMotion ? nil : MaskinMotion.standard) {
						expanded = !(expanded ?? initiallyExpanded)
					}
				} label: {
					Text(isCollapsed ? DescriptionCollapse.readAllLabel(content) : "Show less")
						.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline))
						.foregroundStyle(MaskinColor.ink4)
						.frame(minHeight: MaskinSpace.touchMin)
						.contentShape(Rectangle())
				}
				.buttonStyle(.maskinPressed)
				.padding(.bottom, -MaskinSpace.s7)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}
}
