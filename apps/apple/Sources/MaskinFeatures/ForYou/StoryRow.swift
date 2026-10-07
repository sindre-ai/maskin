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

	private var cards: [StoryCard] { loopID.map { stories.cards(forLoop: $0) } ?? stories.cards }

	var body: some View {
		if !cards.isEmpty {
			ScrollView(.horizontal, showsIndicators: false) {
				LazyHStack(spacing: MaskinSpace.s5) {
					ForEach(cards) { card in
						StoryCardView(card: card, isSeen: stories.isSeen(card)) { open(card) }
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

/// One 124 x 176 card: unit label (a glass pill) and unseen dot on top, the headline below. No ring,
/// no border. An unseen card is the Patina gradient; a seen one is a plain card.
struct StoryCardView: View {
	let card: StoryCard
	let isSeen: Bool
	let action: () -> Void

	private static let size = CGSize(width: 124, height: 176)
	private static let radius: CGFloat = 24

	var body: some View {
		let shape = RoundedRectangle(cornerRadius: Self.radius, style: .continuous)
		Button(action: action) {
			VStack(alignment: .leading, spacing: 0) {
				HStack(alignment: .top, spacing: MaskinSpace.s2) {
					Text(card.unit.uppercased())
						.font(MaskinTypeface.mono(MaskinFontSize.t9, weight: .semibold))
						.tracking(0.63)
						.foregroundStyle(isSeen ? MaskinColor.ink5 : MaskinColor.stLab)
						.lineLimit(2)
						.padding(.horizontal, MaskinSpace.s4)
						.padding(.vertical, MaskinSpace.s2)
						.background(MaskinColor.pill, in: Capsule())
						.overlay(Capsule().strokeBorder(MaskinColor.pillBd, lineWidth: 0.5))
					Spacer(minLength: 0)
					if !isSeen {
						Circle().fill(MaskinColor.sig).frame(width: 7, height: 7)
							.accessibilityHidden(true)
					}
				}
				Spacer(minLength: 0)
				Text(card.headline)
					.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .bold))
					.foregroundStyle(isSeen ? MaskinColor.ink : MaskinColor.stFg)
					.multilineTextAlignment(.leading)
					.lineLimit(5)
			}
			.padding(MaskinSpace.s6)
			.frame(width: Self.size.width, height: Self.size.height)
			.background(fill, in: shape)
			.shadow(color: MaskinPatina.cardShadow, radius: 1, y: 1)
			.shadow(color: MaskinPatina.cardShadow, radius: 9, y: 6)
			.contentShape(shape)
		}
		.buttonStyle(.plain)
		.accessibilityLabel("\(card.unit): \(card.headline)\(isSeen ? "" : ", new")")
		.accessibilityHint("Opens the briefing")
	}

	private var fill: AnyShapeStyle {
		isSeen ? AnyShapeStyle(MaskinSurface.card) : AnyShapeStyle(MaskinGradient.unseenBrief)
	}
}

/// The daily briefing opened full screen: the Chief of Staff's spoken brief as text.
struct BriefingStoryView: View {
	let headline: String
	let script: String
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.s7) {
					Text("YOUR DAILY BRIEFING")
						.font(MaskinTypeface.mono(MaskinFontSize.t10, weight: .semibold))
						.foregroundStyle(MaskinColor.ink4)
					Text(headline).maskinText(.title).foregroundStyle(MaskinColor.ink)
					Text(script).maskinText(.body).foregroundStyle(MaskinColor.ink)
				}
				.frame(maxWidth: 680, alignment: .leading)
				.frame(maxWidth: .infinity)
				.padding(MaskinSpace.s9)
			}
			.ambientBackground(showsBottom: false)
			.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
		}
	}
}
