import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One loop in the list, laid out like a conversation row: the agents working it, the name over
/// its stats, then state and age at the trailing edge.
struct LoopRow: View {
	let loop: LoopSummary
	let agentNames: [String]
	var hasUpdate = false

	var body: some View {
		HStack(alignment: .center, spacing: MaskinSpace.s7) {
			ConversationAvatar(
				participants: agentNames.prefix(2).map { ChatParticipant(id: $0, name: $0, kind: .agent) })
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
					Text(loop.displayName)
						.maskinText(.headline)
						.fontWeight(.semibold)
						.foregroundStyle(MaskinColor.ink)
						.lineLimit(1)
					if hasUpdate {
						Image(systemName: "arrow.up.circle.fill")
							.font(.caption)
							.foregroundStyle(MaskinColor.accentFgStrong)
							.accessibilityLabel("Update available")
					}
					Spacer(minLength: MaskinSpace.s3)
					RelativeTime(loop.updatedAt, style: .compact)
						.maskinText(.caption)
						.foregroundStyle(MaskinColor.ink4)
				}
				if !loop.tags.isEmpty {
					Text(loop.tags.joined(separator: " · "))
						.maskinText(.microLabel)
						.foregroundStyle(MaskinColor.ink4)
						.lineLimit(1)
				}
				HStack(alignment: .center, spacing: MaskinSpace.s4) {
					if loop.waitingCount > 0 {
						Text("\(loop.waitingCount) waiting on you")
							.maskinText(.subhead)
							.foregroundStyle(MaskinColor.warningStrong)
							.lineLimit(1)
					} else {
						Text(loop.statsLine)
							.maskinText(.subhead)
							.foregroundStyle(MaskinColor.ink4)
							.lineLimit(1)
					}
					Spacer(minLength: 0)
					LoopPillView(pill: loop.pill)
				}
			}
		}
		.padding(.vertical, MaskinSpace.s2)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
		.accessibilityLabel(accessibilityLabel)
	}

	private var accessibilityLabel: String {
		var parts = [loop.displayName, loop.pill.label, loop.statsLine]
		if loop.waitingCount > 0 { parts.append("\(loop.waitingCount) waiting on you") }
		if !agentNames.isEmpty { parts.append("Agents: " + agentNames.joined(separator: ", ")) }
		if hasUpdate { parts.append("update available") }
		return parts.joined(separator: ", ")
	}
}

/// Overlapped agent avatars, at most four, with a "+n" for the rest.
struct AgentStrip: View {
	let names: [String]
	let seeds: [String]
	var size: CGFloat = MaskinSpace.s11

	var body: some View {
		HStack(spacing: -MaskinSpace.s3) {
			ForEach(Array(names.prefix(4).enumerated()), id: \.offset) { index, name in
				ActorAvatar(name: name, kind: .agent, size: size, seed: seeds.indices.contains(index) ? seeds[index] : name)
					.overlay(Circle().strokeBorder(MaskinSurface.card, lineWidth: MaskinSpace.s1))
			}
			if names.count > 4 {
				Text("+\(names.count - 4)")
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.ink4)
					.padding(.leading, MaskinSpace.s5)
			}
		}
		.accessibilityHidden(true)
	}
}
