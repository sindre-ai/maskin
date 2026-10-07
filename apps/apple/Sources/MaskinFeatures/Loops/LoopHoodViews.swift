import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// "Something is stuck": the latest run failed or timed out and nothing has run since. A Patina
/// notice with a "!" mark, the run it concerns and an ink "Ask Chief of Staff" pill.
struct LoopProblemBanner: View {
	let problem: FlowProblem
	let loop: LoopSummary
	let directory: ActorDirectory
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

	private var who: String? { directory.name(problem.actorID) }

	private var explanation: String {
		let base = problem.detail ?? "The last run didn't finish."
		return base + " Nothing has run since."
	}

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s5) {
			Text("!")
				.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: .bold, relativeTo: .caption))
				.foregroundStyle(MaskinSurface.onInverse)
				.frame(width: MaskinSpace.s11, height: MaskinSpace.s11)
				.background(MaskinColor.sig, in: Circle())
				.padding(.top, MaskinSpace.s1)
				.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: MaskinSpace.s3) {
				Button { runtime?.openObject(loop.id) } label: {
					HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
						Text(problem.label.uppercased())
							.maskinText(.microLabel).foregroundStyle(MaskinColor.noticeFg2)
						Text((who ?? loop.displayName) + " ›")
							.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: MaskinFontWeight.w650, relativeTo: .footnote))
							.foregroundStyle(MaskinColor.noticeFg)
							.lineLimit(1)
					}
				}
				.buttonStyle(.maskinPressed)
				.accessibilityHint("Opens the flow's timeline")
				Text(explanation)
					.font(MaskinTypeface.sans(MaskinFontSize.t14, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.noticeFg)
					.lineSpacing(MaskinSpace.s1)
					.fixedSize(horizontal: false, vertical: true)
				Button {
					runtime?.buildInChat(
						"The flow \(loop.displayName) is stuck: its last run \(problem.kind == .failed ? "failed" : "timed out"). What happened, and what should we do? ")
				} label: {
					Text("Ask Chief of Staff")
						.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: MaskinFontWeight.w650, relativeTo: .footnote))
						.foregroundStyle(MaskinSurface.onInverse)
						.padding(.horizontal, MaskinSpace.s7)
						.padding(.vertical, MaskinSpace.s3)
						.background(MaskinSurface.inverse, in: Capsule())
				}
				.buttonStyle(.maskinPressed(.shrink))
				.padding(.top, MaskinSpace.s3)
			}
			Spacer(minLength: 0)
		}
		.padding(.vertical, MaskinSpace.s7)
		.padding(.horizontal, MaskinSpace.s8)
		.background(MaskinColor.noticeBg, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous)
				.strokeBorder(MaskinColor.noticeBd, lineWidth: 1)
		)
		.accessibilityElement(children: .contain)
	}
}

/// "Under the hood": how the flow is put together, in the handoff's order: when it runs, the last
/// seven days, what it is for and how it is going, where its work sits now, when it starts and
/// ends, and the steps.
struct LoopHoodSection: View {
	let store: LoopDetailStore
	var onOpenTrigger: (String) -> Void = { _ in }

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s12) {
			LoopScheduleSection(store: store)
			LoopRunChart(activity: store.activity, loaded: store.phase == .loaded)
			outcomeText
			stats
			LoopFlowSection(store: store, onOpenTrigger: onOpenTrigger)
			conditions
			pipeline
		}
	}

	@ViewBuilder
	private var outcomeText: some View {
		if let content = store.loop.content, !content.isEmpty {
			Text(content)
				.font(MaskinTypeface.sans(MaskinFontSize.t16, relativeTo: .body))
				.tracking(-0.01 * MaskinFontSize.t16)
				.foregroundStyle(MaskinColor.ink2)
				.lineSpacing(MaskinSpace.s2)
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(.vertical, MaskinSpace.s9)
				.padding(.horizontal, MaskinSpace.s10)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
		}
	}

	@ViewBuilder
	private var conditions: some View {
		let rows = [("Starts when", store.loop.entryCondition), ("Done when", store.loop.closeCondition)]
			.compactMap { label, value in value.flatMap { $0.isEmpty ? nil : (label, $0) } }
		if !rows.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				FlowSectionHeader("Starts and ends")
				VStack(alignment: .leading, spacing: MaskinSpace.s5) {
					ForEach(rows, id: \.0) { label, value in
						VStack(alignment: .leading, spacing: MaskinSpace.s1) {
							MonoLabel(label)
							Text(value).maskinText(.subhead).foregroundStyle(MaskinColor.ink2)
						}
					}
				}
				.loopCard()
			}
		}
	}

	private var stats: some View {
		let tiles: [(String, String)] = [
			("In progress", "\(store.loop.inProgressCount)"),
			("Closed", "\(store.loop.closedCount)"),
			("Needs you", "\(store.loop.waitingCount)"),
			("Median time", store.loop.medianTimeToClose.map(LoopDurationText.string) ?? "—"),
		]
		return LazyVGrid(
			columns: [GridItem(.adaptive(minimum: 100), spacing: MaskinSpace.s4)], spacing: MaskinSpace.s4
		) {
			ForEach(tiles, id: \.0) { label, value in
				VStack(spacing: MaskinSpace.s2) {
					Text(value)
						.font(MaskinTypeface.sans(MaskinFontSize.t20, weight: MaskinFontWeight.w750, relativeTo: .title3))
						.tracking(-0.02 * MaskinFontSize.t20)
						.foregroundStyle(MaskinColor.ink)
					Text(label)
						.font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption))
						.foregroundStyle(MaskinColor.ink5)
				}
				.frame(maxWidth: .infinity)
				.padding(.vertical, MaskinSpace.s8)
				.padding(.horizontal, MaskinSpace.s7)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
				.accessibilityElement(children: .combine)
			}
		}
	}

	private var pipeline: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			FlowSectionHeader("Steps") {
				Text("\(store.steps.count)").maskinText(.mono).foregroundStyle(MaskinColor.ink4)
			}
			switch store.phase {
			case .idle where store.steps.isEmpty, .loading where store.steps.isEmpty:
				LoadingSkeleton(rows: 3)
			case .failed(let message) where store.steps.isEmpty:
				EmptyState(symbol: "wifi.exclamationmark", title: "Couldn't load steps", message: message) {
					Button("Try again") { Task { await store.refresh() } }.buttonStyle(.secondaryAction)
				}
			default:
				if store.steps.isEmpty {
					Text("This flow has no steps yet.").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
				} else {
					VStack(spacing: 0) {
						ForEach(Array(store.steps.enumerated()), id: \.element.id) { index, step in
							LoopStepRow(
								number: index + 1, step: step, isLast: index == store.steps.count - 1,
								onOpen: { onOpenTrigger(step.triggerID) })
						}
					}
				}
			}
		}
	}
}

/// SCHEDULE: scheduled steps in the order they fire, with when; event-driven steps after, with
/// what wakes them.
struct LoopScheduleSection: View {
	let store: LoopDetailStore

	var body: some View {
		let items = LoopComingUp.items(steps: store.steps, now: Date(), paused: store.loop.isPaused)
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			FlowSectionHeader("Schedule")
			if items.isEmpty {
				Text("This flow runs on its triggers.")
					.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
					.loopNote()
			} else {
				VStack(spacing: 0) {
					ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
						HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s7) {
							VStack(alignment: .leading, spacing: MaskinSpace.s1) {
								Text(item.step.displayName)
									.font(MaskinTypeface.sans(MaskinFontSize.t15, relativeTo: .subheadline))
									.foregroundStyle(MaskinColor.ink)
								Text(item.step.firesSummary)
									.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
							}
							Spacer(minLength: MaskinSpace.s3)
							if let next = item.next {
								Text(next.formatted(date: .abbreviated, time: .shortened))
									.font(MaskinTypeface.mono(MaskinFontSize.t12, weight: .medium))
									.foregroundStyle(MaskinColor.ink5)
									.multilineTextAlignment(.trailing)
							}
						}
						.padding(.vertical, MaskinSpace.s6)
						.accessibilityElement(children: .combine)
						if index < items.count - 1 { Divider().overlay(MaskinSurface.separator) }
					}
				}
				.padding(.horizontal, MaskinSpace.s8)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
			}
		}
	}
}

/// LAST 7 DAYS: runs per day from the flow's activity feed, failed ones in ink over Patina.
struct LoopRunChart: View {
	let activity: [LoopActivityEntry]
	let loaded: Bool

	private static let barHeight: CGFloat = MaskinSpace.s14 + MaskinSpace.s14 + MaskinSpace.s4

	var body: some View {
		let now = Date()
		let days = LoopRunHistory.days(from: activity, now: now)
		let peak = max(days.map(\.runs).max() ?? 0, 1)
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			HStack(alignment: .firstTextBaseline) {
				Text("LAST 7 DAYS")
					.font(MaskinTypeface.mono(MaskinFontSize.t11, weight: .semibold))
					.tracking(0.08 * MaskinFontSize.t11)
					.foregroundStyle(MaskinColor.ink5)
				Spacer(minLength: MaskinSpace.s4)
				Text(loaded ? LoopRunHistory.summary(days) : "")
					.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
					.foregroundStyle(MaskinColor.ink4)
			}
			HStack(alignment: .bottom, spacing: MaskinSpace.s3) {
				ForEach(days) { day in
					VStack(spacing: MaskinSpace.s3) {
						bar(day, peak: peak).frame(height: Self.barHeight, alignment: .bottom)
						Text(day.day.formatted(.dateTime.weekday(.narrow)))
							.font(MaskinTypeface.sans(MaskinFontSize.t10, weight: day.isToday ? .bold : .regular, relativeTo: .caption2))
							.foregroundStyle(day.isToday ? MaskinColor.ink : MaskinColor.ink5)
					}
					.frame(maxWidth: .infinity)
					.accessibilityElement(children: .ignore)
					.accessibilityLabel(
						"\(day.day.formatted(.dateTime.weekday(.wide))), \(day.runs) \(day.runs == 1 ? "run" : "runs")"
							+ (day.failures > 0 ? ", \(day.failures) failed" : ""))
				}
			}
			if LoopRunHistory.mayBeTruncated(activity, now: now) {
				Text("Counted from the latest \(LoopRunHistory.feedLimit) events, so busy days may read low.")
					.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
			}
		}
		.padding(.vertical, MaskinSpace.s8)
		.padding(.horizontal, MaskinSpace.s9)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
	}

	@ViewBuilder
	private func bar(_ day: LoopRunDay, peak: Int) -> some View {
		if day.runs == 0 {
			RoundedRectangle(cornerRadius: MaskinRadius.tag2 + MaskinRadius.tag, style: .continuous)
				.fill(MaskinSurface.fillStrong)
				.frame(maxWidth: .infinity)
				.frame(height: MaskinSpace.s2)
		} else {
			let height = Self.barHeight * CGFloat(day.runs) / CGFloat(peak)
			let failedHeight = height * CGFloat(day.failures) / CGFloat(day.runs)
			VStack(spacing: 0) {
				if day.failures > 0 { Rectangle().fill(MaskinColor.ink).frame(height: failedHeight) }
				Rectangle().fill(MaskinGradient.ring)
			}
			.frame(maxWidth: .infinity)
			.frame(height: max(height, MaskinSpace.s3))
			.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.tag2 + MaskinRadius.tag, style: .continuous))
		}
	}
}
