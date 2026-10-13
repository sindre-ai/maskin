import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The `@` popover above the composer: up to five rows, each a 30pt avatar, the 15pt name and a
/// 13pt role on the right ("Human · Owner", "Agent"). 48pt rows, card radius 20, a soft shadow
/// (spec 7 §1). Tapping a row picks it.
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

	private static let row: CGFloat = MaskinSpace.touchMin + MaskinSpace.s2
	private static let avatar: CGFloat = MaskinSpace.s13 + MaskinSpace.s1
	private let shape = RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous)

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			if people.isEmpty {
				Text("No one by that name")
					.font(MaskinTypeface.sans(MaskinFontSize.t15, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.ink4)
					.padding(.horizontal, MaskinSpace.s8)
					.frame(minHeight: Self.row)
			} else {
				ForEach(Array(people.prefix(MentionRoster.maxRows).enumerated()), id: \.element.id) { index, person in
					if index > 0 { Rectangle().fill(MaskinSurface.separator).frame(height: 1) }
					Button {
						MaskinHaptics.play(.selection)
						onPick(person)
					} label: {
						HStack(spacing: MaskinSpace.s6) {
							ActorAvatar(
								name: person.name, kind: person.kind == .agent ? .agent : .human, size: Self.avatar,
								seed: person.id)
							Text(person.name)
								.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .subheadline))
								.foregroundStyle(MaskinColor.ink)
								.lineLimit(1)
							Spacer(minLength: MaskinSpace.s4)
							Text(person.roleLabel)
								.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
								.foregroundStyle(MaskinColor.ink5)
								.lineLimit(1)
						}
						.padding(.horizontal, MaskinSpace.s8)
						.frame(minHeight: Self.row)
						.contentShape(Rectangle())
					}
					.buttonStyle(.maskinPressed)
					.accessibilityLabel("Mention \(person.name), \(person.roleLabel)")
				}
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: shape)
		.overlay(shape.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.shadow(color: MaskinColor.overlayDim.opacity(0.3), radius: MaskinSpace.s8, y: MaskinSpace.s4)
		.accessibilityElement(children: .contain)
	}
}
