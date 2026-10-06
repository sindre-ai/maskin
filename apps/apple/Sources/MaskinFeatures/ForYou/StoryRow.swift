import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The horizontal row of executive-briefing cards at the top of For you.
struct StoryRow: View {
	let stories: StoriesStore
	let open: (StoryCard) -> Void

	var body: some View {
		if !stories.cards.isEmpty {
			ScrollView(.horizontal, showsIndicators: false) {
				LazyHStack(spacing: MaskinSpace.s5) {
					ForEach(stories.cards) { card in
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

/// One 124 x 176 card: unit label and unseen dot on top, the headline below. Nothing else.
struct StoryCardView: View {
	let card: StoryCard
	let isSeen: Bool
	let action: () -> Void

	private static let size = CGSize(width: 124, height: 176)
	private static let ring: CGFloat = 3
	private static let radius: CGFloat = 24

	var body: some View {
		Button(action: action) {
			ZStack(alignment: .topLeading) {
				RoundedRectangle(cornerRadius: Self.radius - Self.ring, style: .continuous)
					.fill(LinearGradient(colors: [ForYouPalette.storyTop, ForYouPalette.storyBottom], startPoint: .top, endPoint: .bottom))
				VStack(alignment: .leading, spacing: 0) {
					HStack(alignment: .top, spacing: MaskinSpace.s2) {
						Text(card.unit.uppercased())
							.font(MaskinTypeface.mono(MaskinFontSize.t9, weight: .semibold))
							.foregroundStyle(ForYouPalette.storyAccent)
							.lineLimit(2)
						Spacer(minLength: 0)
						if !isSeen {
							Circle().fill(ForYouPalette.storyAccent).frame(width: 7, height: 7)
								.accessibilityHidden(true)
						}
					}
					Spacer(minLength: 0)
					Text(card.headline)
						.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .bold))
						.foregroundStyle(ForYouPalette.storyText)
						.multilineTextAlignment(.leading)
						.lineLimit(5)
				}
				.padding(MaskinSpace.s6)
			}
			.padding(Self.ring)
			.frame(width: Self.size.width, height: Self.size.height)
			.background(ring, in: RoundedRectangle(cornerRadius: Self.radius, style: .continuous))
			.contentShape(RoundedRectangle(cornerRadius: Self.radius, style: .continuous))
		}
		.buttonStyle(.plain)
		.accessibilityLabel("\(card.unit): \(card.headline)\(isSeen ? "" : ", new")")
		.accessibilityHint("Opens the briefing")
	}

	private var ring: AnyShapeStyle {
		isSeen
			? AnyShapeStyle(MaskinSurface.line)
			: AnyShapeStyle(
				LinearGradient(
					colors: [ForYouPalette.storyAccent, ForYouPalette.storyRing], startPoint: .topLeading,
					endPoint: .bottomTrailing))
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
			.background(MaskinSurface.grouped)
			.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
		}
	}
}
