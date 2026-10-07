import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One loop in the list as a glanceable card: progress ring, name, "cycle · stage", an amber
/// "Needs you" pill when the viewer is the blocker, and three stats. Pure values in, so it renders in previews and snapshots.
struct LoopCard: View {
	let loop: LoopSummary
	let agentCount: Int
	let needsYou: Bool
	var hasUpdate = false

	private static let ringSize: CGFloat = MaskinSpace.s14 + MaskinSpace.s4

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s6) {
			header
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
							.foregroundStyle(MaskinColor.sigInk)
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
		LoopProgressRing(loop: loop, size: Self.ringSize, lineWidth: MaskinSpace.s2)
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
		"\(loop.cycleLabel) · \(loop.pill.label)"
	}

	private var accessibilityLabel: String {
		var parts = [loop.displayName, stageLine]
		if needsYou { parts.append("Needs you") }
		parts.append("\(loop.inProgressCount) in progress, \(loop.closedCount) closed, \(agentCount) agents")
		if hasUpdate { parts.append("update available") }
		return parts.joined(separator: ". ")
	}
}

extension LoopSummary {
	/// The progress ring's fill: the share of the loop's work that has closed.
	var progress: Double {
		let total = inProgressCount + closedCount
		return total == 0 ? 0 : Double(closedCount) / Double(total)
	}

	/// "Cycle 3": the cycle now running, one past those already closed.
	var cycleLabel: String { "Cycle \(closedCount + 1)" }
}

/// The loop's progress as a ring with the percentage inside: the card's 40pt and the page
/// header's larger one are the same view.
struct LoopProgressRing: View {
	let loop: LoopSummary
	let size: CGFloat
	let lineWidth: CGFloat

	var body: some View {
		ZStack {
			Circle().stroke(MaskinSurface.fillStrong, lineWidth: lineWidth)
			Circle()
				.trim(from: 0, to: loop.progress)
				.stroke(
					loop.pill.isLive ? AnyShapeStyle(MaskinGradient.ring) : AnyShapeStyle(MaskinGradient.ringPaused),
					style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
				)
				.rotationEffect(.degrees(-90))
			Text("\(Int((loop.progress * 100).rounded()))")
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.ink3)
		}
		.frame(width: size, height: size)
		.accessibilityHidden(true)
	}
}
