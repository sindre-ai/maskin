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

	/// For you shows unseen cards first; a loop's own page keeps its newest-first order.
	private var cards: [StoryCard] { loopID.map { stories.cards(forLoop: $0) } ?? stories.rowCards }

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
	/// A fixed height (the iPhone For you row); nil takes the shared briefing height.
	var height: CGFloat?
	/// The v5 hero card on the dark For you header: headline, round badge and mono unit label.
	var ringed = false

	static let compact = StoryCardMetrics(width: 124, radius: 24)
	/// iPhone For you (v5): 108 x 144, radius 20, on the dark header.
	static let forYou = StoryCardMetrics(width: 108, radius: 20, height: 144, ringed: true)
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
		if metrics.ringed { ringedBody } else { plainBody }
	}

	/// The v5 hero card (108 x 144, radius 20) on the dark header: headline on top, a round badge
	/// and the mono unit label below. An unseen card is white; a seen one is translucent white.
	/// Opening it fades it to the seen look and moves it to the end of the row.
	private var ringedBody: some View {
		let shape = RoundedRectangle(cornerRadius: metrics.radius, style: .continuous)
		let look = HeroLook(isSeen: isSeen)
		return Button(action: action) {
			VStack(alignment: .leading, spacing: MaskinSpace.s4) {
				Text(card.headline)
					.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .bold))
					.tracking(-0.17)
					.lineSpacing(1)
					.foregroundStyle(look.foreground)
					.multilineTextAlignment(.leading)
					.lineLimit(5)
					.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
				HStack(spacing: MaskinSpace.s3) {
					Image(systemName: card.isBriefing ? "play.fill" : "doc.text.fill")
						.maskinSymbol(MaskinFontSize.t11, weight: .bold)
						.foregroundStyle(look.badgeForeground)
						.frame(width: MaskinSpace.s12, height: MaskinSpace.s12)
						.background(look.badge, in: Circle())
					Text(card.unit.uppercased())
						.font(MaskinTypeface.mono(MaskinFontSize.t9, weight: .semibold))
						.maskinMonoLabelScale()
						.tracking(0.63)
						.foregroundStyle(look.label)
						.lineLimit(1)
						.minimumScaleFactor(0.7)
				}
				.accessibilityHidden(true)
			}
			.padding(MaskinSpace.s6)
			.frame(width: metrics.width, height: height, alignment: .topLeading)
			.background(look.fill, in: shape)
			.overlay(shape.strokeBorder(look.border, lineWidth: 1))
			.contentShape(shape)
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel("\(card.unit): \(card.headline), \(card.formatLabel)\(isSeen ? "" : ", new")")
		.accessibilityHint("Opens the briefing")
	}

	private var height: CGFloat {
		metrics.height ?? MaskinScaling.briefingCardHeight(for: typeSize)
	}

	@ViewBuilder private var plainBody: some View {
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
				width: metrics.width, height: height)
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

/// The colours of a hero card (v5 `s.bg/s.bd/s.fg/s.badge/s.kc`): white while unseen, translucent
/// white once seen. The header is dark in both modes, so these do not follow the colour scheme.
private struct HeroLook {
	let isSeen: Bool

	var fill: Color { isSeen ? Color.white.opacity(0.1) : .white }
	var border: Color { isSeen ? Color.white.opacity(0.16) : .white }
	var foreground: Color { isSeen ? .white : MaskinColor.patina900 }
	var badge: Color { isSeen ? Color.white.opacity(0.14) : MaskinColor.patina900 }
	var badgeForeground: Color { isSeen ? MaskinColor.patina200 : .white }
	var label: Color { isSeen ? MaskinColor.patina200 : MaskinColor.patina700 }
}
