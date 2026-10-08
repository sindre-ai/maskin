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

/// TARGET on a flow's Outcome tab: one card per target, hidden when the flow has none. No due
/// date or forecast line: the API carries neither.
struct LoopTargetsSection: View {
	let cards: [OutcomeCard]
	let directory: ActorDirectory

	var body: some View {
		ForEach(cards) { card in
			VStack(alignment: .leading, spacing: MaskinSpace.s3) {
				HStack {
					Text("TARGET")
						.font(MaskinTypeface.mono(MaskinFontSize.t11, weight: .semibold))
						.tracking(0.08 * MaskinFontSize.t11)
						.foregroundStyle(MaskinColor.ink5)
					Spacer(minLength: MaskinSpace.s4)
					if let owner = directory.actor(card.target.ownerID) {
						ActorAvatar(
							name: owner.name, kind: owner.isAgent ? .agent : .human, size: MaskinSpace.s11,
							seed: owner.id)
					}
				}
				HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3 + MaskinSpace.s1) {
					Text(number(card.target.actual))
						.font(MaskinTypeface.sans(MaskinFontSize.t32, weight: MaskinFontWeight.w750, relativeTo: .largeTitle))
						.tracking(-0.03 * MaskinFontSize.t32)
						.foregroundStyle(MaskinColor.ink)
					Text("of \(number(card.target.target))")
						.font(MaskinTypeface.sans(MaskinFontSize.t14, relativeTo: .subheadline))
						.foregroundStyle(MaskinColor.ink5)
				}
				Text(card.target.label)
					.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: MaskinFontWeight.w650, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.ink)
				OutcomeBar(fraction: card.target.fraction, status: card.status)
					.padding(.top, MaskinSpace.s4)
				HStack(spacing: MaskinSpace.s3) {
					Circle().fill(card.status.dot).frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
					Text(card.status.label)
						.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: MaskinFontWeight.w650, relativeTo: .footnote))
						.foregroundStyle(card.status.textColor)
				}
				.padding(.top, MaskinSpace.s2)
				.accessibilityElement(children: .combine)
			}
			.padding(.vertical, MaskinSpace.s9)
			.padding(.horizontal, MaskinSpace.s10)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(
				MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous)
			)
			.accessibilityElement(children: .combine)
			.accessibilityLabel(
				"\(card.target.label), \(number(card.target.actual)) of \(number(card.target.target)), \(card.status.label)"
			)
		}
	}
}

/// OUTCOMES above the loops list: a horizontal row of score cards, one per target.
struct OutcomeScoreRow: View {
	let cards: [OutcomeCard]
	var onOpen: (String) -> Void = { _ in }

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			MonoLabel("Outcomes")
				.padding(.horizontal, MaskinSpace.s9)
			ScrollView(.horizontal, showsIndicators: false) {
				LazyHStack(spacing: MaskinSpace.s5) {
					ForEach(cards) { card in
						Button { onOpen(card.loopID) } label: { scoreCard(card) }
							.buttonStyle(.maskinPressed(.shrink))
					}
				}
				.padding(.horizontal, MaskinSpace.s7)
			}
			MonoLabel("Flows")
				.padding(.horizontal, MaskinSpace.s9)
				.padding(.top, MaskinSpace.s3)
		}
	}

	private func scoreCard(_ card: OutcomeCard) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			HStack(spacing: MaskinSpace.s3) {
				Text(card.target.label).maskinText(.caption).foregroundStyle(MaskinColor.ink4).lineLimit(2)
				Spacer(minLength: 0)
				Circle().fill(card.status.dot).frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
			}
			HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s2) {
				Text(number(card.target.actual)).maskinText(.title).foregroundStyle(MaskinColor.ink)
				Text("of \(number(card.target.target))")
					.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
			}
			OutcomeBar(fraction: card.target.fraction, status: card.status)
			Text(card.status.label).maskinText(.caption).foregroundStyle(card.status.textColor)
			Text(card.loopName).maskinText(.caption).foregroundStyle(MaskinColor.ink5).lineLimit(1)
		}
		.padding(MaskinSpace.s7)
		.frame(width: MaskinSpace.s14 * 4, alignment: .leading)
		.background(
			MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
		)
		.accessibilityElement(children: .combine)
		.accessibilityLabel(
			"\(card.target.label), \(number(card.target.actual)) of \(number(card.target.target)), \(card.status.label), \(card.loopName)"
		)
	}
}

/// QUALITY on a flow's Outcome tab: three small cards of what is measured today (cycles done,
/// decisions needed, failed steps). Rework and edit rate wait for the API to record edits.
struct LoopQualitySection: View {
	let loop: LoopSummary
	/// Steps that failed in the last seven days.
	let failedSteps: Int

	var body: some View {
		let stats = LoopQuality.cardStats(for: loop, failedSteps: failedSteps)
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			FlowSectionHeader("Quality")
			HStack(alignment: .top, spacing: MaskinSpace.s4) {
				ForEach(stats) { stat in
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
					}
					.frame(maxWidth: .infinity, alignment: .leading)
					.padding(.vertical, MaskinSpace.s7)
					.padding(.horizontal, MaskinSpace.s7)
					.background(
						MaskinSurface.card,
						in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous)
					)
					.accessibilityElement(children: .combine)
				}
			}
		}
	}
}
