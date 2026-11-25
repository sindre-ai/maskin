import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// "Something is stuck": a step failed, a decision has waited on the viewer over 48 hours, or
/// nothing has moved for twice the usual step time. A Patina notice with a "!" mark, the cause
/// from the copy deck and an ink "Ask Chief of Staff" pill (the only action: nothing reruns a step).
struct LoopProblemBanner: View {
	let problem: FlowProblem
	let loop: LoopSummary
	let directory: ActorDirectory
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

	private var who: String? { directory.name(problem.actorID) }

	private var explanation: String {
		[problem.headline, problem.detail].compactMap { $0 }.joined(separator: " ")
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
					runtime?.buildInChat(problem.question(flow: loop.displayName))
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

/// What the flow is for: its description in one card. Nothing when it has none.
struct LoopAboutSection: View {
	let loop: LoopSummary

	var body: some View {
		if let content = loop.content, !content.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				FlowSectionHeader("About")
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
	}
}

/// "Starts when" and "Ends when", as the flow states them. Nothing when neither is set.
struct LoopConditionsSection: View {
	let loop: LoopSummary

	var body: some View {
		let rows = [("Starts when", loop.entryCondition), ("Ends when", loop.closeCondition)]
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
									.font(MaskinTypeface.mono(MaskinFontSize.t12, weight: .semibold))
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
