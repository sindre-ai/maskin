import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The `@` picker above the composer: people in this conversation first, then the workspace.
struct MentionSuggestions: View {
	let candidates: [ChatParticipant]
	let inConversation: Set<String>
	let onPick: (ChatParticipant) -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			if candidates.isEmpty {
				Text("No one by that name").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
					.padding(MaskinSpace.s8)
			} else {
				ForEach(candidates.prefix(6)) { person in
					Button {
						MaskinHaptics.play(.selection)
						onPick(person)
					} label: {
						HStack(spacing: MaskinSpace.s6) {
							ActorAvatar(
								name: person.name, kind: person.kind == .agent ? .agent : .human,
								size: MaskinSpace.s12 + MaskinSpace.s2, seed: person.id)
							Text(person.name).maskinText(.body).foregroundStyle(MaskinColor.ink).lineLimit(1)
							Spacer(minLength: 0)
							if person.kind == .agent {
								Text("AGENT").maskinText(.microLabel).foregroundStyle(MaskinColor.ink5)
							}
							if inConversation.contains(person.id) {
								Text("in chat").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
							}
						}
						.padding(.horizontal, MaskinSpace.s8)
						.frame(minHeight: MaskinSpace.touchMin)
						.contentShape(Rectangle())
					}
					.buttonStyle(.plain)
					.accessibilityLabel("Mention \(person.name)")
				}
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1))
	}
}
