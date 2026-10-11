import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The horizontal row of executive-briefing cards at the top of For you.
struct StoryRow: View {
	let stories: StoriesStore
	/// Limits the row to one loop's cards (the loop page); nil shows every card (For you).
	var loopID: String?
	let open: (StoryCard) -> Void
	/// Card size: 124 x 24 radius on iPhone; the wide For you feed passes its own.
	var metrics = StoryCardMetrics.compact

	private var cards: [StoryCard] { loopID.map { stories.cards(forLoop: $0) } ?? stories.cards }

	var body: some View {
		if !cards.isEmpty {
			ScrollView(.horizontal, showsIndicators: false) {
				LazyHStack(spacing: MaskinSpace.s5) {
					ForEach(cards) { card in
						StoryCardView(card: card, isSeen: stories.isSeen(card), metrics: metrics) { open(card) }
					}
				}
				.scrollTargetLayout()
			}
			.scrollTargetBehavior(.viewAligned)
			.scrollClipDisabled()
			.accessibilityElement(children: .contain)
			.accessibilityLabel("Briefings")
		}
	}
}

/// Width and corner radius of a briefing card. The height is the same everywhere (176, growing
/// to 220 at accessibility text sizes; Decision 2).
struct StoryCardMetrics: Equatable {
	var width: CGFloat
	var radius: CGFloat

	static let compact = StoryCardMetrics(width: 124, radius: 24)
	/// iPad (4-iPad.md): 204 wide, radius 28; 150 wide while the sidebar takes room.
	static let regular = StoryCardMetrics(width: 204, radius: 28)
	static let regularWithSidebar = StoryCardMetrics(width: 150, radius: 28)
}

/// One 124 x 176 card (220 tall at accessibility text sizes): unit label (a glass pill) and unseen dot on top, the headline below. No ring,
/// no border. An unseen card is the Patina gradient; a seen one is a plain card. The mono format
/// line under the headline says what opening it gives (`READ · 1 MIN`).
struct StoryCardView: View {
	let card: StoryCard
	let isSeen: Bool
	var metrics = StoryCardMetrics.compact
	let action: () -> Void

	private static let padding: CGFloat = 14
	@Environment(\.dynamicTypeSize) private var typeSize

	var body: some View {
		let shape = RoundedRectangle(cornerRadius: metrics.radius, style: .continuous)
		Button(action: action) {
			VStack(alignment: .leading, spacing: 0) {
				HStack(alignment: .top, spacing: MaskinSpace.s2) {
					Text(card.unit.uppercased())
						.font(MaskinTypeface.mono(MaskinFontSize.t9, weight: .semibold))
						.maskinMonoLabelScale()
						.tracking(0.63)
						.foregroundStyle(isSeen ? MaskinColor.ink5 : MaskinColor.stLab)
						.lineLimit(2)
						.padding(.horizontal, MaskinSpace.s4)
						.padding(.vertical, MaskinSpace.s2)
						.background(MaskinColor.pill, in: Capsule())
						.overlay(Capsule().strokeBorder(MaskinColor.pillBd, lineWidth: 0.5))
					Spacer(minLength: 0)
					if !isSeen {
						Circle().fill(MaskinColor.stLab).frame(width: 7, height: 7)
							.accessibilityHidden(true)
					}
				}
				Spacer(minLength: 0)
				Text(card.headline)
					.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .bold))
					.tracking(-0.225)
					.lineSpacing(MaskinSpace.s1)
					.foregroundStyle(isSeen ? MaskinColor.ink : MaskinColor.stFg)
					.multilineTextAlignment(.leading)
					.lineLimit(5)
				Text(card.formatLabel)
					.font(MaskinTypeface.mono(MaskinFontSize.t9, weight: .semibold))
					.maskinMonoLabelScale()
					.tracking(0.63)
					.foregroundStyle(isSeen ? MaskinColor.ink5 : MaskinColor.stLab)
					.lineLimit(1)
					.padding(.top, MaskinSpace.s3)
			}
			.padding(Self.padding)
			.frame(
				width: metrics.width, height: MaskinScaling.briefingCardHeight(for: typeSize))
			.background(fill, in: shape)
			.shadow(color: MaskinPatina.cardShadow, radius: 1, y: 1)
			.shadow(color: MaskinPatina.cardShadow, radius: 9, y: 6)
			.contentShape(shape)
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel("\(card.unit): \(card.headline), \(card.formatLabel)\(isSeen ? "" : ", new")")
		.accessibilityHint("Opens the briefing")
	}

	private var fill: AnyShapeStyle {
		isSeen ? AnyShapeStyle(MaskinSurface.card) : AnyShapeStyle(MaskinGradient.unseenBrief)
	}
}
