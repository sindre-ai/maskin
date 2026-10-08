import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One flow in the list as a glanceable card: icon tile, name, "cycle · stage", a Patina "Needs you"
/// chip when the viewer is the blocker, the newest thing an agent said as one line of secondary
/// text, and the flow's first target inline. Stats live on the flow page, not here. Pure values in,
/// so it renders in previews and snapshots.
struct LoopCard: View {
	let loop: LoopSummary
	let needsYou: Bool
	var hasUpdate = false
	var update: LoopLatestUpdate.Line?
	/// The most urgent target, when the flow has any.
	var target: OutcomeCard?

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			header
			if let update { latest(update) }
			if let target { targetBlock(target) }
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
			Image(systemName: "arrow.triangle.2.circlepath")
				.font(.system(size: MaskinSpace.s10, weight: .semibold))
				.foregroundStyle(MaskinColor.sigInk)
				.frame(width: MaskinSpace.s14 + MaskinSpace.s4, height: MaskinSpace.s14 + MaskinSpace.s4)
				.background(MaskinColor.sigTint, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
				.accessibilityHidden(true)
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

	/// The newest post as one line of secondary text, its author in semibold ahead of the rest.
	private func latest(_ update: LoopLatestUpdate.Line) -> some View {
		Group {
			if let author = update.author {
				Text(author).fontWeight(.semibold).foregroundStyle(MaskinColor.ink3) + Text(" " + update.text)
			} else {
				Text(update.text)
			}
		}
		.font(MaskinTypeface.sans(MaskinFontSize.t14, relativeTo: .subheadline))
		.foregroundStyle(MaskinColor.ink4)
		.lineLimit(1)
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	/// Value, "of {target}", status, label and bar. No due date and no forecast: the API has neither.
	private func targetBlock(_ card: OutcomeCard) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
				Text(number(card.target.actual))
					.font(MaskinTypeface.sans(MaskinFontSize.t24, weight: MaskinFontWeight.w750, relativeTo: .title2))
					.tracking(-0.028 * MaskinFontSize.t24)
					.foregroundStyle(MaskinColor.ink)
				Text("of \(number(card.target.target))")
					.font(MaskinTypeface.sans(MaskinFontSize.t14, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.ink5)
				Spacer(minLength: MaskinSpace.s3)
				Text(card.status.label)
					.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: MaskinFontWeight.w650, relativeTo: .footnote))
					.foregroundStyle(card.status.textColor)
			}
			Text(card.target.label)
				.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline))
				.foregroundStyle(MaskinColor.ink3)
				.lineLimit(1)
			OutcomeBar(fraction: card.target.fraction, status: card.status)
				.padding(.top, MaskinSpace.s3)
		}
		.padding(.top, MaskinSpace.s2)
	}

	/// "Cycle 3 · Define", or the lifecycle rung while the stage is still unknown.
	private var stageLine: String {
		"\(loop.cycleLabel) · \(loop.pill.label)"
	}

	private var accessibilityLabel: String {
		var parts = [loop.displayName, stageLine]
		if needsYou { parts.append("Needs you") }
		if let update { parts.append(([update.author, update.text].compactMap { $0 }).joined(separator: " ")) }
		if let target {
			parts.append(
				"\(target.target.label), \(number(target.target.actual)) of \(number(target.target.target)), \(target.status.label)")
		}
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
