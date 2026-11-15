import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

extension OutcomeStatus {
	/// Bar fill from the Patina outcome tokens.
	var bar: LinearGradient {
		switch self {
		case .needsYou: MaskinGradient.Outcome.needsYou
		case .atRisk: MaskinGradient.Outcome.atRisk
		case .watch: MaskinGradient.Outcome.watch
		case .onTrack: MaskinGradient.Outcome.onTrack
		}
	}

	var dot: Color {
		switch self {
		case .needsYou: MaskinPatina.dotNeedsYou
		case .atRisk: MaskinPatina.dotAtRisk
		case .watch: MaskinPatina.dotWatch
		case .onTrack: MaskinPatina.dotOnTrack
		}
	}

	/// Status text: Patina ink for on track, plain ink otherwise (urgency is shade and text).
	var textColor: Color { self == .onTrack ? MaskinColor.sigInk : MaskinColor.ink }
}

func number(_ value: Double) -> String {
	value.formatted(.number.precision(.fractionLength(0...1)))
}

/// A target's progress bar in its status shade.
struct OutcomeBar: View {
	let fraction: Double
	let status: OutcomeStatus

	var body: some View {
		Capsule().fill(MaskinSurface.line)
			.overlay(alignment: .leading) {
				GeometryReader { geo in
					Capsule().fill(status.bar).frame(width: geo.size.width * fraction)
				}
			}
			.frame(height: MaskinSpace.s3)
			.clipShape(Capsule())
			.accessibilityHidden(true)
	}
}

/// TARGETS on a flow's Overview tab (v19): one card per target with its name, a status badge, the
/// figure, a bar and, when the source reads as words, "Source: Tasks". Hidden when the flow has
/// none. No due date or forecast line: the API carries neither.
struct LoopTargetsSection: View {
	let cards: [OutcomeCard]
	let directory: ActorDirectory

	var body: some View {
		if !cards.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				FlowSectionHeader("Targets")
				ForEach(cards) { card in
					VStack(alignment: .leading, spacing: MaskinSpace.s5) {
						HStack(alignment: .top, spacing: MaskinSpace.s5) {
							Text(card.target.label)
								.font(MaskinTypeface.sans(MaskinFontSize.t17, weight: MaskinFontWeight.w650, relativeTo: .headline))
								.foregroundStyle(MaskinColor.ink)
								.fixedSize(horizontal: false, vertical: true)
							Spacer(minLength: MaskinSpace.s3)
							badge(card.status)
						}
						Text("\(number(card.target.actual)) of \(number(card.target.target))")
							.font(MaskinTypeface.sans(MaskinFontSize.t24, weight: MaskinFontWeight.w750, relativeTo: .title2))
							.tracking(-0.028 * MaskinFontSize.t24)
							.foregroundStyle(MaskinColor.ink)
						FlowProgressBar(fraction: card.target.fraction, status: card.status)
						HStack(spacing: MaskinSpace.s4) {
							if let source = FlowTargetSource.label(card.target.source) {
								Text("Source: \(source)").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
							}
							if card.target.isManual == true {
								Text("Manual").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
							}
							Spacer(minLength: 0)
							if let owner = directory.actor(card.target.ownerID) {
								ActorAvatar(
									name: owner.name, kind: owner.isAgent ? .agent : .human, size: MaskinSpace.s11,
									seed: owner.id)
							}
						}
					}
					.padding(.vertical, MaskinSpace.s8)
					.padding(.horizontal, MaskinSpace.s9)
					.frame(maxWidth: .infinity, alignment: .leading)
					.background(
						MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous)
					)
					.overlay(
						RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous)
							.strokeBorder(MaskinSurface.line, lineWidth: 1)
					)
					.accessibilityElement(children: .combine)
					.accessibilityLabel(
						"\(card.target.label), \(number(card.target.actual)) of \(number(card.target.target)), \(card.status.label)"
					)
				}
			}
		}
	}

	private func badge(_ status: OutcomeStatus) -> some View {
		let ok = status == .onTrack
		return Text(status.label)
			.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: MaskinFontWeight.bold, relativeTo: .subheadline))
			.foregroundStyle(ok ? MaskinColor.ok : MaskinColor.warning)
			.padding(.horizontal, MaskinSpace.s6)
			.padding(.vertical, MaskinSpace.s3)
			.background(ok ? MaskinColor.okTint : MaskinColor.warningTint, in: Capsule())
	}
}

/// STATS on a flow's Outcome tab: three small cards of what is measured today (cycles done,
/// decisions needed, failed steps). Rework and edit rate wait for the API to record edits.
struct LoopStatsSection: View {
	let loop: LoopSummary
	/// Steps that failed in the last seven days.
	let failedSteps: Int

	var body: some View {
		let stats = LoopQuality.cardStats(for: loop, failedSteps: failedSteps)
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			FlowSectionHeader("Stats")
			HStack(alignment: .top, spacing: MaskinSpace.s4) {
				ForEach(stats) { FlowStatTile(stat: $0) }
			}
		}
	}
}

/// One number and its label on a small card: the flow's Performance tiles and the Flows overview strip.
struct FlowStatTile: View {
	let stat: LoopQuality.Stat

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			Text(stat.value)
				.font(MaskinTypeface.sans(MaskinFontSize.t20, weight: MaskinFontWeight.w750, relativeTo: .title3))
				.tracking(-0.02 * MaskinFontSize.t20)
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(1)
				.minimumScaleFactor(0.7)
			Text(stat.label)
				.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: MaskinFontWeight.w650, relativeTo: .caption))
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(1)
				.minimumScaleFactor(0.8)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(.vertical, MaskinSpace.s7)
		.padding(.horizontal, MaskinSpace.s7)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
		.accessibilityElement(children: .combine)
	}
}
