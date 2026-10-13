import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// What an ended live call left in its chat: who was on it, how long, how many lines each side
/// spoke, the last thing the agent said, and the whole transcript behind a disclosure. A call
/// with no recognised speech says so instead of pretending.
struct LiveMeetingCard: View {
	let note: LiveMeetingNote
	@State private var expanded = false

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			HStack(spacing: MaskinSpace.s3) {
				Image(systemName: "waveform").foregroundStyle(MaskinColor.ink4).accessibilityHidden(true)
				MonoLabel("LIVE MEETING · \(note.durationText)")
			}
			Text(note.heading).maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
			if note.turns.isEmpty {
				Text(LiveMeetingNote.emptyText).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			} else {
				Text(counts).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				if let first = note.firstYouTurn { line("You said", first.text) }
				if let last = note.lastAgentTurn { line("\(last.speaker) ended with", last.text) }
				DisclosureGroup(isExpanded: $expanded) {
					VStack(alignment: .leading, spacing: MaskinSpace.s4) {
						ForEach(Array(note.turns.enumerated()), id: \.offset) { _, turn in
							(Text(turn.speaker + "  ").fontWeight(.semibold) + Text(turn.text))
								.maskinText(.subhead).foregroundStyle(MaskinColor.ink)
								.frame(maxWidth: .infinity, alignment: .leading)
						}
					}
					.padding(.top, MaskinSpace.s4)
					.textSelection(.enabled)
				} label: {
					Text(expanded ? "Hide transcript" : "Show transcript")
						.maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
				}
			}
		}
		.padding(MaskinSpace.s9)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
		.accessibilityElement(children: .contain)
	}

	private var counts: String {
		let you = note.youCount == 1 ? "1 line from you" : "\(note.youCount) lines from you"
		let other = note.agentCount == 1 ? "1 reply" : "\(note.agentCount) replies"
		return "\(you) · \(other)"
	}

	private func line(_ label: String, _ text: String) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s1) {
			Text(label).maskinText(.caption).foregroundStyle(MaskinColor.ink5)
			Text(text).maskinText(.subhead).foregroundStyle(MaskinColor.ink).lineLimit(3)
		}
	}
}
