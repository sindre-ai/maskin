import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One loop in the list as a glanceable card: progress ring, name, "cycle · stage", an amber
/// "Needs you" pill when the viewer is the blocker, the latest agent update as one sentence with
/// its author in bold, and three stats. Pure values in, so it renders in previews and snapshots.
struct LoopCard: View {
	let loop: LoopSummary
	let digest: LoopDigest?
	/// The latest update's author, resolved; the sentence shows without one when unresolved.
	let authorName: String?
	let agentCount: Int
	let needsYou: Bool
	var hasUpdate = false

	private static let ringSize: CGFloat = MaskinSpace.s14 + MaskinSpace.s4

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s6) {
			header
			if let sentence = digest?.latestSentence, !sentence.isEmpty {
				Divider()
				update(sentence)
			}
			Divider()
			stats
		}
		.padding(MaskinSpace.s8)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
		.accessibilityLabel(accessibilityLabel)
	}

	private var header: some View {
		HStack(alignment: .center, spacing: MaskinSpace.s7) {
			ring
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				HStack(spacing: MaskinSpace.s3) {
					Text(loop.displayName)
						.maskinText(.headline)
						.foregroundStyle(MaskinColor.ink)
						.lineLimit(2)
					if hasUpdate {
						Image(systemName: "arrow.up.circle.fill")
							.font(.caption)
							.foregroundStyle(MaskinColor.accentFgStrong)
							.accessibilityLabel("Update available")
					}
				}
				Text(stageLine)
					.maskinText(.subhead)
					.foregroundStyle(MaskinColor.ink4)
					.lineLimit(1)
			}
			Spacer(minLength: MaskinSpace.s3)
			if needsYou { needsPill }
		}
	}

	private var ring: some View {
		ZStack {
			Circle().stroke(MaskinSurface.fillStrong, lineWidth: MaskinSpace.s2)
			Circle()
				.trim(from: 0, to: loop.progress)
				.stroke(
					loop.pill.isLive ? MaskinColor.accent : MaskinColor.ink5,
					style: StrokeStyle(lineWidth: MaskinSpace.s2, lineCap: .round)
				)
				.rotationEffect(.degrees(-90))
			Text("\(Int((loop.progress * 100).rounded()))")
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.ink3)
		}
		.frame(width: Self.ringSize, height: Self.ringSize)
		.accessibilityHidden(true)
	}

	private var needsPill: some View {
		Text("Needs you")
			.maskinText(.caption).fontWeight(.semibold)
			.foregroundStyle(MaskinColor.warningStrong)
			.padding(.horizontal, MaskinSpace.s4)
			.padding(.vertical, MaskinSpace.s2)
			.background(MaskinColor.warningTint, in: Capsule())
			.fixedSize()
	}

	private func update(_ sentence: String) -> some View {
		Group {
			if let authorName {
				Text("\(Text(authorName).fontWeight(.bold)) \(sentence)")
			} else {
				Text(sentence)
			}
		}
		.maskinText(.subhead)
		.foregroundStyle(MaskinColor.ink2)
		.frame(maxWidth: .infinity, alignment: .leading)
		.fixedSize(horizontal: false, vertical: true)
	}

	private var stats: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s7) {
			stat("\(loop.inProgressCount)", "in progress")
			stat("\(loop.closedCount)", "closed")
			stat("\(agentCount)", agentCount == 1 ? "agent" : "agents")
		}
	}

	private func stat(_ value: String, _ label: String) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s1) {
			Text(value)
				.maskinText(.headline).fontWeight(.bold)
				.foregroundStyle(MaskinColor.ink)
			Text(label)
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.ink4)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	/// "Cycle 3 · Define", or the lifecycle rung while the stage is still unknown.
	private var stageLine: String {
		let stage = digest?.stage.map(MaskinStatus.label(for:)) ?? loop.pill.label
		return "\(loop.cycleLabel) · \(stage)"
	}

	private var accessibilityLabel: String {
		var parts = [loop.displayName, stageLine]
		if needsYou { parts.append("Needs you") }
		if let sentence = digest?.latestSentence { parts.append([authorName, sentence].compactMap { $0 }.joined(separator: " ")) }
		parts.append("\(loop.inProgressCount) in progress, \(loop.closedCount) closed, \(agentCount) agents")
		if hasUpdate { parts.append("update available") }
		return parts.joined(separator: ". ")
	}
}
