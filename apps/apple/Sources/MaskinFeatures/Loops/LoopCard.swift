import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One flow in the list as a glanceable card (v4): name and state pill, three numbers, the agents
/// on it with the newest thing one of them said, a callout when the flow waits on the viewer, and
/// the flow's first target inline. Pure values in, so it renders in previews and snapshots.
struct LoopCard: View {
	let loop: LoopSummary
	let needsYou: Bool
	var hasUpdate = false
	var update: LoopLatestUpdate.Line?
	/// The agents on the flow, by display name.
	var agentNames: [String] = []
	/// The most urgent target, when the flow has any.
	var target: OutcomeCard?

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			header
			stats
			if update != nil || !agentNames.isEmpty { latestRow }
			if let target { targetBlock(target) }
			if loop.waitingCount > 0 || needsYou { waitingCallout }
		}
		.padding(MaskinSpace.s9)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous)
				.strokeBorder(MaskinSurface.separator, lineWidth: 1)
		)
		.contentShape(Rectangle())
		.maskinHover(.lift, cornerRadius: MaskinRadius.tile)
		.accessibilityElement(children: .combine)
		.accessibilityLabel(accessibilityLabel)
	}

	private var header: some View {
		HStack(alignment: .center, spacing: MaskinSpace.s4) {
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
			Spacer(minLength: MaskinSpace.s3)
			Text(loop.pill.label)
				.maskinText(.caption)
				.fontWeight(.bold)
				.foregroundStyle(MaskinColor.sigInk)
				.padding(.horizontal, MaskinSpace.s5)
				.frame(height: MaskinSpace.s12)
				.background(MaskinColor.sigTint, in: Capsule())
		}
	}

	/// Waiting on you, in progress, closed.
	private var stats: some View {
		HStack(alignment: .bottom, spacing: MaskinSpace.s11) {
			stat(loop.waitingCount, "Waiting on you")
			stat(loop.inProgressCount, "In progress")
			stat(loop.closedCount, "Closed")
		}
	}

	private func stat(_ value: Int, _ label: String) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s1) {
			Text("\(value)")
				.font(MaskinTypeface.sans(MaskinFontSize.t22, weight: .heavy, relativeTo: .title2))
				.monospacedDigit()
				.foregroundStyle(MaskinColor.ink)
			Text(label).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
		}
		.fixedSize()
	}

	/// The agents on the flow as overlapping initials, then the newest post and when it was written.
	private var latestRow: some View {
		HStack(alignment: .center, spacing: MaskinSpace.s5) {
			if !agentNames.isEmpty { FlowAvatarStack(names: agentNames) }
			if let update { latest(update) } else { Spacer(minLength: 0) }
			if let date = update?.date {
				RelativeTime(date, style: .compact)
					.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
			}
		}
		.padding(.top, MaskinSpace.s5)
		.overlay(alignment: .top) { Rectangle().fill(MaskinSurface.separator).frame(height: 1) }
	}

	/// The flow waits on the viewer: a tinted callout that reads the count.
	private var waitingCallout: some View {
		HStack(spacing: MaskinSpace.s4) {
			Circle().fill(MaskinScreenHeader.inkTop).frame(width: MaskinSpace.s3 + 1, height: MaskinSpace.s3 + 1)
				.accessibilityHidden(true)
			Text(loop.waitingCount > 0 ? "\(loop.waitingCount) waiting on you" : "Needs you")
				.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline))
				.foregroundStyle(MaskinScreenHeader.inkTop)
			Spacer(minLength: 0)
			Image(systemName: "chevron.right")
				.maskinSymbol(MaskinFontSize.t13, weight: .semibold)
				.foregroundStyle(MaskinColor.sig)
				.accessibilityHidden(true)
		}
		.padding(.horizontal, MaskinSpace.s7)
		.padding(.vertical, MaskinSpace.s5)
		.background(MaskinColor.sigTint, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
	}

	/// The newest post as text, its author in semibold ahead of the rest.
	private func latest(_ update: LoopLatestUpdate.Line) -> some View {
		Group {
			if let author = update.author {
				Text(author).fontWeight(.semibold).foregroundStyle(MaskinColor.ink3) + Text(" " + update.text)
			} else {
				Text(update.text)
			}
		}
		.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
		.foregroundStyle(MaskinColor.ink4)
		.lineLimit(2)
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
				.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: .semibold, relativeTo: .body))
				.foregroundStyle(MaskinColor.ink2)
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
		var parts = [loop.displayName, stageLine, "\(loop.waitingCount) waiting on you, \(loop.inProgressCount) in progress, \(loop.closedCount) closed"]
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

/// Up to three agents on a flow as overlapping initials on the avatar gradient, then "+n".
struct FlowAvatarStack: View {
	let names: [String]
	var limit = 3

	var body: some View {
		HStack(spacing: -MaskinSpace.s3) {
			ForEach(Array(names.prefix(limit).enumerated()), id: \.offset) { _, name in
				Text(name.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? "?")
					.maskinText(.caption)
					.fontWeight(.bold)
					.foregroundStyle(MaskinColor.avFg)
					.frame(width: MaskinSpace.s13 - MaskinSpace.s2, height: MaskinSpace.s13 - MaskinSpace.s2)
					.background(Circle().fill(MaskinGradient.avatar))
					.overlay(Circle().strokeBorder(MaskinSurface.card, lineWidth: 2))
			}
			if names.count > limit {
				Text("+\(names.count - limit)")
					.maskinText(.caption).fontWeight(.semibold).foregroundStyle(MaskinColor.ink4)
					.padding(.leading, MaskinSpace.s5)
			}
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("Agents: \(names.joined(separator: ", "))")
	}
}
