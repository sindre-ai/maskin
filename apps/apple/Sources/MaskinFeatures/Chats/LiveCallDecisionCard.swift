import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// "DECIDING NOW · n OPEN": the dock's card for the person's open For You decisions, one at a time.
/// The recommended option leads as a full-width button, the others sit under it, smaller. A tap
/// answers (the dock does that through the For You store and tells the agent), then the next
/// decision takes the card's place. `queue` is already ordered and filtered by `LiveDecisionQueue`.
struct LiveCallDecisionCard: View {
	let queue: [ForYouCard]
	let onChoose: (DecisionOption, ForYouCard) -> Void

	var body: some View {
		if let card = queue.first {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				MonoLabel("Deciding now · \(queue.count) open", color: MaskinColor.sigInk)
					.accessibilityAddTraits(.isHeader)
				Text(LiveDecisionQueue.question(of: card))
					.maskinText(.subhead).fontWeight(.bold).foregroundStyle(MaskinColor.ink)
					.lineLimit(3).multilineTextAlignment(.leading)
					.frame(maxWidth: .infinity, alignment: .leading)
				if let primary = LiveDecisionQueue.primary(of: card) {
					Button { onChoose(primary, card) } label: {
						Text(primary.label).lineLimit(2).multilineTextAlignment(.center)
					}
					.buttonStyle(.primaryAction)
				}
				let alternates = LiveDecisionQueue.alternates(of: card)
				if !alternates.isEmpty {
					HStack(spacing: MaskinSpace.s4) {
						ForEach(alternates.prefix(2)) { option in
							Button { onChoose(option, card) } label: {
								Text(option.label).maskinText(.subhead).fontWeight(.semibold)
									.foregroundStyle(MaskinColor.ink).lineLimit(1)
									.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
									.background(
										MaskinSurface.card,
										in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
							}
							.buttonStyle(.maskinPressed(.shrink))
						}
					}
				}
			}
			.padding(MaskinSpace.s7)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(MaskinColor.sigTint, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
			.id(card.id)
			.transition(.opacity)
			.animation(MaskinMotion.quick, value: card.id)
			.accessibilityElement(children: .contain)
		}
	}
}
