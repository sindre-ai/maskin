import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One loop in the list, on a single line: name, then what's waiting, its state and its age.
/// The stats line and the agents live on the loop's detail.
struct LoopRow: View {
	let loop: LoopSummary
	let agentNames: [String]
	var hasUpdate = false

	var body: some View {
		HStack(spacing: MaskinSpace.s4) {
			Text(loop.displayName)
				.maskinText(.subhead)
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(1)
			Spacer(minLength: MaskinSpace.s3)
			if hasUpdate {
				Image(systemName: "arrow.up.circle.fill")
					.font(.caption)
					.foregroundStyle(MaskinColor.accentFgStrong)
					.accessibilityLabel("Update available")
			}
			if loop.waitingCount > 0 {
				Text("\(loop.waitingCount) waiting")
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.warningStrong)
			}
			LoopPillView(pill: loop.pill)
			RelativeTime(loop.updatedAt, style: .compact)
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.ink5)
		}
		.padding(.vertical, MaskinSpace.s3)
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
