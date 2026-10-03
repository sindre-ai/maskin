import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One loop in the list: name, state, stats, the agents involved and when it last moved.
struct LoopRow: View {
	let loop: LoopSummary
	let agentNames: [String]
	var hasUpdate = false

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
				Text(loop.displayName)
					.maskinText(.headline)
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(2)
				Spacer(minLength: MaskinSpace.s3)
				LoopPillView(pill: loop.pill)
			}
			HStack(spacing: MaskinSpace.s4) {
				Text(loop.statsLine)
					.maskinText(.subhead)
					.foregroundStyle(MaskinColor.ink4)
					.lineLimit(2)
				if loop.waitingCount > 0 {
					Text("\(loop.waitingCount) waiting")
						.maskinText(.subhead)
						.foregroundStyle(MaskinColor.warningStrong)
				}
			}
			HStack(spacing: MaskinSpace.s4) {
				AgentStrip(names: agentNames, seeds: loop.agentIDs)
				if hasUpdate { MonoLabel("Update available", color: MaskinColor.accentFgStrong) }
				Spacer(minLength: 0)
				RelativeTime(loop.updatedAt, style: .compact)
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.ink5)
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
