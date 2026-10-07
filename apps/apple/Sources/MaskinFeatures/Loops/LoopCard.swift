import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One flow in the list as a glanceable card: progress ring, name, "cycle · stage", a Patina
/// "Needs you" chip when the viewer is the blocker, the newest thing an agent said, and three
/// stats. Pure values in, so it renders in previews and snapshots.
struct LoopCard: View {
	let loop: LoopSummary
	let agentCount: Int
	let needsYou: Bool
	var hasUpdate = false
	var update: LoopLatestUpdate.Line?

	private static let ringSize: CGFloat = MaskinSpace.s14 + MaskinSpace.s4

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			header
			VStack(alignment: .leading, spacing: MaskinSpace.s7) {
				Divider().overlay(MaskinSurface.separator)
				if let update { latest(update) }
				stats
			}
		}
		.padding(.vertical, MaskinSpace.s9)
		.padding(.horizontal, MaskinSpace.s10)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.brief, style: .continuous))
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
		.accessibilityLabel(accessibilityLabel)
	}

	private var header: some View {
		HStack(alignment: .center, spacing: MaskinSpace.s8) {
			ring
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				HStack(spacing: MaskinSpace.s3) {
					Text(loop.displayName)
						.font(MaskinTypeface.sans(MaskinFontSize.t17, weight: MaskinFontWeight.bold, relativeTo: .headline))
						.tracking(-0.018 * MaskinFontSize.t17)
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
					.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
					.foregroundStyle(MaskinColor.ink5)
					.lineLimit(1)
			}
			Spacer(minLength: MaskinSpace.s3)
			if needsYou { NeedsYouChip() }
		}
	}

	private var ring: some View {
		LoopProgressRing(
			loop: loop, size: Self.ringSize, lineWidth: MaskinSpace.s2,
			valueFont: MaskinTypeface.mono(MaskinFontSize.t10, weight: .semibold))
	}

	/// The newest post as one sentence, its author in bold ink ahead of the grey text.
	private func latest(_ update: LoopLatestUpdate.Line) -> some View {
		Group {
			if let author = update.author {
				Text(author).fontWeight(.semibold).foregroundStyle(MaskinColor.ink) + Text(" " + update.text)
			} else {
				Text(update.text)
			}
		}
		.font(MaskinTypeface.sans(MaskinFontSize.t15, relativeTo: .subheadline))
		.foregroundStyle(MaskinColor.ink3)
		.lineSpacing(MaskinSpace.s1)
		.lineLimit(4)
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	private var stats: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s4) {
			stat("\(loop.inProgressCount)", "in progress")
			stat("\(loop.closedCount)", "closed")
			stat("\(agentCount)", agentCount == 1 ? "agent" : "agents")
		}
	}

	private func stat(_ value: String, _ label: String) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s1) {
			Text(value)
				.font(MaskinTypeface.sans(MaskinFontSize.t18, weight: MaskinFontWeight.bold, relativeTo: .headline))
				.tracking(-0.02 * MaskinFontSize.t18)
				.foregroundStyle(MaskinColor.ink)
			Text(label)
				.font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption))
				.foregroundStyle(MaskinColor.ink5)
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
		if let update { parts.append(([update.author, update.text].compactMap { $0 }).joined(separator: " ")) }
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
	var valueFont: Font = MaskinTextRole.caption.font

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
				.font(valueFont)
				.foregroundStyle(MaskinColor.ink)
		}
		.frame(width: size, height: size)
		.accessibilityHidden(true)
	}
}
