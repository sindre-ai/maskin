import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One flow in the Flows list (v19): a status dot and word, the headline figure of its most urgent
/// target with its label and bar, the newest thing an agent said, and, while decisions wait on the
/// viewer, a footer banner with one action. A card without a target shows no figure, label or bar;
/// there is no pace line or "today" marker because the API carries no due date or rate. Pure values
/// in, so it renders in previews and snapshots.
struct LoopCard: View {
	let loop: LoopSummary
	let needsYou: Bool
	var hasUpdate = false
	var update: LoopLatestUpdate.Line?
	/// The title of the decision that waits, for the banner. Nil reads the count alone.
	var decisionTitle: String?
	/// Opens the flow from the banner's button.
	var onReview: () -> Void = {}

	private var figures: FlowsOverview.Figures? { FlowsOverview.figures(loop) }
	private var banner: String? { FlowsOverview.banner(loop, decisionTitle: decisionTitle) }

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s6) {
			header
			if let figures { metric(figures) }
			if let work = FlowsOverview.workLine(loop) {
				Text(work).maskinText(.subhead).foregroundStyle(MaskinColor.ink4).lineLimit(1)
			}
			if let update { latest(update) }
			if let banner { bannerView(banner) }
		}
		.padding(.vertical, MaskinSpace.s9)
		.padding(.horizontal, MaskinSpace.s9)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.brief, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.brief, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1)
		)
		.contentShape(Rectangle())
		.maskinHover(.lift, cornerRadius: MaskinRadius.brief)
		.accessibilityElement(children: .contain)
		.accessibilityLabel(accessibilityLabel)
	}

	private var header: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s5) {
			Circle().fill(dot).frame(width: MaskinSpace.s4 + MaskinSpace.s1, height: MaskinSpace.s4 + MaskinSpace.s1)
				.accessibilityHidden(true)
			Text(loop.displayName)
				.font(MaskinTypeface.sans(MaskinFontSize.t17, weight: MaskinFontWeight.bold, relativeTo: .headline))
				.tracking(-0.018 * MaskinFontSize.t17)
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(2)
			if hasUpdate {
				Image(systemName: "arrow.up.circle.fill")
					.font(.caption)
					.foregroundStyle(MaskinColor.accent)
					.accessibilityLabel("Update available")
			}
			Spacer(minLength: MaskinSpace.s3)
			Text(statusWord)
				.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: MaskinFontWeight.w650, relativeTo: .subheadline))
				.foregroundStyle(needsYou ? MaskinColor.warning : MaskinColor.ink4)
				.lineLimit(1)
		}
	}

	private var needsYouNow: Bool { needsYou && loop.status.isLive }
	private var statusWord: String { needsYouNow ? "Needs you" : loop.status.label }
	private var dot: Color {
		if needsYouNow { return MaskinColor.warning }
		return loop.status.isLive ? MaskinColor.ok : MaskinColor.ink5
	}

	private func metric(_ figures: FlowsOverview.Figures) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			Text(figures.value)
				.font(MaskinTypeface.sans(MaskinFontSize.t32, weight: MaskinFontWeight.w750, relativeTo: .largeTitle))
				.tracking(-0.03 * MaskinFontSize.t32)
				.foregroundStyle(MaskinColor.ink)
				.minimumScaleFactor(0.7)
				.lineLimit(1)
			Text(figures.label)
				.font(MaskinTypeface.sans(MaskinFontSize.t16, relativeTo: .body))
				.foregroundStyle(MaskinColor.ink4)
				.lineLimit(2)
			FlowProgressBar(fraction: figures.fraction, status: figures.status)
				.padding(.top, MaskinSpace.s3)
		}
		.accessibilityElement(children: .combine)
		.accessibilityLabel("\(figures.label), \(figures.value), \(figures.status.label)")
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

	private func bannerView(_ message: String) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s6) {
			Text(message)
				.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: .semibold, relativeTo: .body))
				.foregroundStyle(MaskinColor.ink)
				.fixedSize(horizontal: false, vertical: true)
			HStack {
				Spacer(minLength: 0)
				Button(action: onReview) {
					Text("Review")
						.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: MaskinFontWeight.bold, relativeTo: .subheadline))
						.foregroundStyle(MaskinSurface.onInverse)
						.padding(.horizontal, MaskinSpace.s9)
						.frame(minHeight: MaskinSpace.touchMin)
						.background(MaskinSurface.inverse, in: Capsule())
				}
				.buttonStyle(.maskinPressed(.shrink))
			}
		}
		.padding(MaskinSpace.s7)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.cardInset2, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
	}

	private var accessibilityLabel: String {
		var parts = [loop.displayName, statusWord]
		if let figures { parts.append("\(figures.label), \(figures.value), \(figures.status.label)") }
		if let work = FlowsOverview.workLine(loop) { parts.append(work) }
		if let update { parts.append(([update.author, update.text].compactMap { $0 }).joined(separator: " ")) }
		if let banner { parts.append(banner) }
		if hasUpdate { parts.append("update available") }
		return parts.joined(separator: ". ")
	}
}

/// A target's progress bar: cobalt while on track, the warning colour otherwise.
struct FlowProgressBar: View {
	let fraction: Double
	let status: OutcomeStatus

	var body: some View {
		Capsule().fill(MaskinSurface.line)
			.overlay(alignment: .leading) {
				GeometryReader { geo in
					Capsule().fill(status.flowTint).frame(width: geo.size.width * fraction)
				}
			}
			.frame(height: MaskinSpace.s3)
			.clipShape(Capsule())
			.accessibilityHidden(true)
	}
}

extension OutcomeStatus {
	/// Bar and badge colour on the v19 Flows and Targets surfaces.
	var flowTint: Color { self == .onTrack ? MaskinColor.accent : MaskinColor.warning }
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
