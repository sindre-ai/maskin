import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The line below the person's last message while agents work (chat list design spec v12): a still
/// ring, then "Forge and Sage are working", each name a link to that agent's session. No typing
/// indicator, no animation.
struct ThreadWorkingLine: View {
	struct Agent: Identifiable, Equatable {
		var name: String
		var sessionID: String
		var id: String { sessionID }
	}

	let agents: [Agent]
	let onOpenSession: (String) -> Void

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
			Circle()
				.strokeBorder(MaskinColor.ink5, lineWidth: 1.5)
				.overlay {
					Circle().inset(by: 0.75).trim(from: 0.625, to: 0.875)
						.stroke(MaskinColor.ink, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
				}
				.frame(width: ChatListRowV2.ring, height: ChatListRowV2.ring)
				.accessibilityHidden(true)
			ChipFlow(spacing: MaskinSpace.s1) {
				ForEach(Array(agents.enumerated()), id: \.element.id) { index, agent in
					HStack(spacing: 0) {
						Button { onOpenSession(agent.sessionID) } label: {
							Text(agent.name)
								.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold, relativeTo: .footnote))
								.foregroundStyle(MaskinColor.ink)
								.underline()
						}
						.buttonStyle(.plain)
						.accessibilityLabel("\(agent.name), open session")
						let joiner = ChatWorkingLine.joiner(after: index, of: agents.count)
						if !joiner.isEmpty {
							Text(joiner).font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
						}
					}
				}
				Text(ChatWorkingLine.verb(for: agents.count))
					.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
			}
		}
		.foregroundStyle(MaskinColor.ink4)
		.frame(maxWidth: .infinity, alignment: .leading)
		.accessibilityElement(children: .contain)
	}
}
