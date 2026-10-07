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

private func number(_ value: Double) -> String {
	value.formatted(.number.precision(.fractionLength(0...1)))
}

/// A target's progress bar in its status shade.
private struct OutcomeBar: View {
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

/// TARGET on a loop's Outcomes tab: one card per target, hidden when the loop has none.
struct LoopTargetsSection: View {
	let cards: [OutcomeCard]
	let directory: ActorDirectory

	var body: some View {
		ForEach(cards) { card in
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				HStack {
					MonoLabel("Target")
					Spacer(minLength: MaskinSpace.s4)
					if let owner = directory.actor(card.target.ownerID) {
						ActorAvatar(
							name: owner.name, kind: owner.isAgent ? .agent : .human, size: MaskinSpace.s11,
							seed: owner.id)
					}
				}
				HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
					Text(number(card.target.actual)).maskinText(.title).foregroundStyle(MaskinColor.ink)
					Text("/ \(number(card.target.target))")
						.maskinText(.subhead).foregroundStyle(MaskinColor.ink5)
				}
				Text(card.target.label).maskinText(.headline).foregroundStyle(MaskinColor.ink)
				OutcomeBar(fraction: card.target.fraction, status: card.status)
				HStack(spacing: MaskinSpace.s3) {
					Circle().fill(card.status.dot).frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
					Text(card.status.label).maskinText(.caption).foregroundStyle(card.status.textColor)
				}
				.accessibilityElement(children: .combine)
			}
			.padding(MaskinSpace.s8)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(
				MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
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
							.buttonStyle(.plain)
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

/// QUALITY on a loop's Outcomes tab: the counts the API reports, plus when it next runs.
struct LoopQualitySection: View {
	let loop: LoopSummary
	let steps: [LoopStep]

	var body: some View {
		let stats = LoopQuality.stats(
			for: loop, nextRun: LoopQuality.nextRun(steps: steps, now: Date(), paused: loop.isPaused),
			duration: LoopDurationText.string,
			date: { $0.formatted(.relative(presentation: .numeric, unitsStyle: .abbreviated)) })
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			SectionHeader("Quality")
			LazyVGrid(
				columns: [GridItem(.adaptive(minimum: 110), spacing: MaskinSpace.s5)], spacing: MaskinSpace.s5
			) {
				ForEach(stats) { stat in
					VStack(alignment: .leading, spacing: MaskinSpace.s2) {
						Text(stat.value).maskinText(.headline).foregroundStyle(MaskinColor.ink)
						Text(stat.label).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
					}
					.frame(maxWidth: .infinity, alignment: .leading)
					.padding(MaskinSpace.s7)
					.background(
						MaskinSurface.card,
						in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
					)
					.accessibilityElement(children: .combine)
				}
			}
		}
	}
}
