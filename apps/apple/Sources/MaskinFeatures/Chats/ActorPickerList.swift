import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One flat, multi-select list of everyone who can be added to a chat: people and agents together,
/// A to Z, best match first while searching (see `AddPeople.candidates`). Integration and system
/// accounts never appear.
struct ActorPickerList: View {
	let actors: [ChatActor]
	let excluding: Set<String>
	@Binding var selection: Set<String>
	let query: String
	/// The workspace list has not arrived yet: six placeholder rows.
	var isLoading = false
	/// Workspace role per person ("Owner", "Member"), shown as their second line.
	var roles: [String: String] = [:]

	var body: some View {
		let rows = AddPeople.candidates(actors, excluding: excluding, query: query)
		if isLoading {
			ForEach(0..<6, id: \.self) { _ in skeletonRow }
		} else if rows.isEmpty {
			Section { Text(AddPeople.emptyText(query: query)).foregroundStyle(MaskinColor.ink4) }
		} else {
			Section {
				ForEach(rows) { actor in row(actor) }
			}
		}
	}

	private var skeletonRow: some View {
		HStack(spacing: MaskinSpace.s7) {
			SkeletonBlock(height: MaskinSpace.s13 + MaskinSpace.s3, cornerRadius: MaskinRadius.btn)
				.frame(width: MaskinSpace.s13 + MaskinSpace.s3)
			VStack(alignment: .leading, spacing: MaskinSpace.s3) {
				SkeletonBlock(height: MaskinSpace.s7).frame(width: 120)
				SkeletonBlock(height: MaskinSpace.s5).frame(width: 80)
			}
			Spacer(minLength: 0)
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("Loading")
	}

	/// An agent's role line is its own description; a person's is their workspace role.
	private func detail(_ actor: ChatActor) -> String? {
		actor.participant.kind == .agent ? actor.summary : roles[actor.id]
	}

	private func row(_ actor: ChatActor) -> some View {
		let picked = selection.contains(actor.id)
		return Button {
			if picked { selection.remove(actor.id) } else { selection.insert(actor.id) }
			MaskinHaptics.play(.selection)
		} label: {
			HStack(spacing: MaskinSpace.s7) {
				ActorAvatar(
					name: actor.participant.name,
					kind: actor.participant.kind == .agent ? .agent : .human,
					size: MaskinSpace.s13 + MaskinSpace.s3, seed: actor.id,
					mood: AgentMood(actor.agentState))
				VStack(alignment: .leading, spacing: 0) {
					Text(actor.participant.name).maskinText(.body).foregroundStyle(MaskinColor.ink)
					if let detail = detail(actor), !detail.isEmpty {
						Text(detail).maskinText(.caption).foregroundStyle(MaskinColor.ink4).lineLimit(1)
					}
				}
				Spacer()
				Image(systemName: picked ? "checkmark.circle.fill" : "circle")
					.foregroundStyle(picked ? MaskinColor.ink : MaskinColor.ink5)
					.accessibilityHidden(true)
			}
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityAddTraits(picked ? .isSelected : [])
	}
}
