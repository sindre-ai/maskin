import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The row of briefing cards at the top of For you. The first card is always the daily briefing;
/// an unopened one is tinted and carries a dot, an opened one is a plain card.
struct BriefingRow: View {
	let cards: [BriefingCard]
	let seen: BriefingSeen
	/// Bumped when a card is opened so the row re-reads `seen`.
	let refresh: Int
	let open: (BriefingCard) -> Void

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s5) {
				ForEach(cards) { card in
					BriefingCardView(card: card, isSeen: seen.isSeen(card.id)) { open(card) }
				}
			}
			.padding(.horizontal, MaskinSpace.s8)
			.padding(.vertical, MaskinSpace.s4)
		}
		.id(refresh)
		.accessibilityElement(children: .contain)
	}
}

private struct BriefingCardView: View {
	let card: BriefingCard
	let isSeen: Bool
	let action: () -> Void

	private let shape = RoundedRectangle(cornerRadius: MaskinRadius.hero + MaskinSpace.s3, style: .continuous)

	var body: some View {
		Button(action: action) {
			VStack(alignment: .leading, spacing: 0) {
				HStack(alignment: .top) {
					Text(card.unit)
						.maskinText(.microLabel)
						.padding(.horizontal, MaskinSpace.s4)
						.padding(.vertical, MaskinSpace.s2)
						.background(MaskinSurface.fill, in: Capsule())
					Spacer(minLength: 0)
					if !isSeen {
						Circle().fill(ForYouPalette.storyUnseenLabel).frame(width: 7, height: 7)
							.accessibilityHidden(true)
					}
				}
				Spacer(minLength: 0)
				Text(card.title)
					.maskinText(.headline)
					.multilineTextAlignment(.leading)
					.lineLimit(4)
				Text(card.formatLabel)
					.maskinText(.microLabel)
					.padding(.top, MaskinSpace.s3)
					.foregroundStyle(isSeen ? MaskinColor.ink5 : ForYouPalette.storyUnseenLabel)
			}
			.foregroundStyle(isSeen ? MaskinColor.ink : ForYouPalette.storyUnseenTitle)
			.padding(MaskinSpace.s7)
			.frame(width: 148, height: 196, alignment: .leading)
			.background(isSeen ? MaskinSurface.card : ForYouPalette.storyUnseenBackground, in: shape)
			.contentShape(shape)
		}
		.buttonStyle(.plain)
		.accessibilityElement(children: .combine)
		.accessibilityLabel("\(card.unit.capitalized) briefing. \(card.title). \(card.formatLabel.lowercased()).")
		.accessibilityHint(isSeen ? "" : "New")
	}
}

/// The text reader for a briefing: a calm, formatted page, not a raw dump of markdown.
struct BriefingReader: View {
	let card: BriefingCard
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.s7) {
					VStack(alignment: .leading, spacing: MaskinSpace.s3) {
						Text("\(card.unit) · \(card.formatLabel)")
							.maskinText(.microLabel).foregroundStyle(ForYouPalette.storyUnseenLabel)
						Text(card.title).maskinText(.largeTitle).foregroundStyle(MaskinColor.ink)
					}
					switch card.format {
					case .text(let markdown):
						MarkdownContent(markdown, style: .document)
					}
				}
				.frame(maxWidth: 680, alignment: .leading)
				.padding(.horizontal, MaskinSpace.s9)
				.padding(.vertical, MaskinSpace.s9)
				.frame(maxWidth: .infinity)
			}
			.background(MaskinSurface.grouped)
			.navigationTitle("")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
			}
		}
	}
}
