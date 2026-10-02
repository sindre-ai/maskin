import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Multi-select list of workspace actors, agents first. Shared by the new-chat sheet and "add
/// people" in an existing conversation.
struct ActorPickerList: View {
	let actors: [ChatActor]
	let excluding: Set<String>
	@Binding var selection: Set<String>
	let query: String
	/// Actor ids to float to the top of each section (people you talk to most recently).
	var recent: [String] = []

	var body: some View {
		let visible = actors.filter {
			!excluding.contains($0.id) && !$0.isSystem
				&& (query.isEmpty || $0.participant.name.localizedCaseInsensitiveContains(query))
		}
		let rank = Dictionary(recent.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
		let ordered = visible.sorted { (rank[$0.id] ?? .max) < (rank[$1.id] ?? .max) }
		let agents = ordered.filter { $0.participant.kind == .agent }
		let people = ordered.filter { $0.participant.kind == .human }
		if visible.isEmpty {
			Section { Text(query.isEmpty ? "No one to add." : "No matches.").foregroundStyle(MaskinColor.ink4) }
		}
		if !agents.isEmpty { section("Agents", agents) }
		if !people.isEmpty { section("People", people) }
	}

	private func section(_ title: String, _ items: [ChatActor]) -> some View {
		Section(title) {
			ForEach(items) { actor in
				Button {
					if selection.contains(actor.id) { selection.remove(actor.id) } else { selection.insert(actor.id) }
					MaskinHaptics.play(.selection)
				} label: {
					HStack(spacing: MaskinSpace.s7) {
						ActorAvatar(
							name: actor.participant.name,
							kind: actor.participant.kind == .agent ? .agent : .human,
							size: MaskinSpace.s13 + MaskinSpace.s3, seed: actor.id,
							working: actor.agentState == .running)
						VStack(alignment: .leading, spacing: 0) {
							Text(actor.participant.name).maskinText(.body).foregroundStyle(MaskinColor.ink)
							if let summary = actor.summary, !summary.isEmpty {
								Text(summary).maskinText(.caption).foregroundStyle(MaskinColor.ink4).lineLimit(1)
							}
						}
						Spacer()
						Image(systemName: selection.contains(actor.id) ? "checkmark.circle.fill" : "circle")
							.foregroundStyle(selection.contains(actor.id) ? MaskinColor.accent : MaskinColor.ink5)
							.accessibilityHidden(true)
					}
					.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
				.accessibilityAddTraits(selection.contains(actor.id) ? .isSelected : [])
			}
		}
	}
}
