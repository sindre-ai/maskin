import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The `@` list above the composer: up to five rows, each with an avatar, the name and a role label
/// on the right ("Human · Owner", "Agent"). Tapping a row picks it; the composer writes `@FirstName `.
struct MentionSuggestions: View {
	let people: [MentionPerson]
	let onPick: (MentionPerson) -> Void

	init(people: [MentionPerson], onPick: @escaping (MentionPerson) -> Void) {
		self.people = people
		self.onPick = onPick
	}

	/// Source-compatible with the first picker: people without roles. `inConversation` no longer
	/// draws a tag; the roster orders those people first instead.
	init(
		candidates: [ChatParticipant], inConversation: Set<String> = [],
		onPick: @escaping (ChatParticipant) -> Void
	) {
		self.people = candidates.map { MentionPerson(id: $0.id, name: $0.name, kind: $0.kind) }
		self.onPick = { onPick($0.participant) }
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			if people.isEmpty {
				Text("No one by that name").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
					.padding(MaskinSpace.s8)
			} else {
				ForEach(people.prefix(MentionRoster.maxRows)) { person in
					Button {
						MaskinHaptics.play(.selection)
						onPick(person)
					} label: {
						HStack(spacing: MaskinSpace.s6) {
							ActorAvatar(
								name: person.name, kind: person.kind == .agent ? .agent : .human,
								size: MaskinSpace.s14 - MaskinSpace.s1, seed: person.id)
							Text(person.name).maskinText(.body).fontWeight(.semibold)
								.foregroundStyle(MaskinColor.ink).lineLimit(1)
							Spacer(minLength: MaskinSpace.s4)
							Text(person.roleLabel).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
								.lineLimit(1)
						}
						.padding(.horizontal, MaskinSpace.s8)
						.frame(minHeight: MaskinSpace.touchMin)
						.contentShape(Rectangle())
					}
					.buttonStyle(.plain)
					.accessibilityLabel("Mention \(person.name), \(person.roleLabel)")
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
