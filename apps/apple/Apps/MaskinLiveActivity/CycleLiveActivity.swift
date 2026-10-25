import ActivityKit
import AppIntents
import MaskinCore
import MaskinDesign
import SwiftUI
import WidgetKit

/// A flow cycle running now: ring and percent, "CYCLE 12 · VERIFY", the flow's name, one sentence
/// of who is doing what, and a bar. When the cycle ends needing the reader the same card becomes
/// "NEEDS YOU" with Review and Later, and ends after the reader opens it or after eight hours.
struct CycleLiveActivity: Widget {
	var body: some WidgetConfiguration {
		ActivityConfiguration(for: MaskinCycleAttributes.self) { context in
			CycleLockScreenView(attributes: context.attributes, state: context.state)
				.padding(MaskinSpace.s9)
				.activityBackgroundTint(MaskinSurface.card)
				.widgetURL(context.attributes.openURL)
		} dynamicIsland: { context in
			let state = context.state
			return DynamicIsland {
				DynamicIslandExpandedRegion(.leading) {
					CycleRing(state: state, size: 44)
				}
				DynamicIslandExpandedRegion(.center) {
					VStack(alignment: .leading, spacing: MaskinSpace.s1) {
						Text(state.phase == .needsYou ? "NEEDS YOU" : state.eyebrow)
							.maskinText(.microLabel).foregroundStyle(MaskinColor.sigInk).lineLimit(1)
						Text("\(state.flowName) \u{00B7} \(state.percent)%")
							.maskinText(.headline).lineLimit(1)
					}
				}
				DynamicIslandExpandedRegion(.bottom) {
					VStack(alignment: .leading, spacing: MaskinSpace.s4) {
						CycleSummary(state: state, font: .subhead, color: MaskinColor.ink3)
						CycleActions(attributes: context.attributes, state: state)
					}
					.frame(maxWidth: .infinity, alignment: .leading)
				}
			} compactLeading: {
				CycleRing(state: state, size: 20)
			} compactTrailing: {
				Text("\(state.percent)%").maskinText(.mono).monospacedDigit()
			} minimal: {
				CycleRing(state: state, size: 20)
			}
			.widgetURL(context.attributes.openURL)
			.keylineTint(MaskinColor.sig)
		}
	}
}

/// The progress ring. Signal while running; ink once it needs the reader (done work is ink).
struct CycleRing: View {
	let state: CycleActivityState
	var size: CGFloat
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	var body: some View {
		let line = max(2, size * 0.1)
		ZStack {
			Circle().stroke(MaskinSurface.line, lineWidth: line)
			Circle()
				.trim(from: 0, to: state.progress)
				.stroke(
					state.phase == .needsYou ? MaskinColor.ink : MaskinColor.sig,
					style: StrokeStyle(lineWidth: line, lineCap: .round)
				)
				.rotationEffect(.degrees(-90))
				.animation(reduceMotion ? nil : .linear(duration: MaskinDuration.slide), value: state.progress)
			if size >= 32 {
				Text("\(state.percent)%")
					.font(MaskinTypeface.sans(size * 0.3, weight: .bold, relativeTo: .caption2))
					.monospacedDigit()
					.foregroundStyle(MaskinColor.ink)
					.minimumScaleFactor(0.6)
			}
		}
		.frame(width: size, height: size)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("\(state.percent) percent")
	}
}

private struct CycleActions: View {
	let attributes: MaskinCycleAttributes
	let state: CycleActivityState

	var body: some View {
		if state.phase == .needsYou {
			HStack(spacing: MaskinSpace.s4) {
				Link(destination: attributes.openURL) {
					Text("Review")
						.maskinText(.subhead).fontWeight(.semibold)
						.foregroundStyle(MaskinPatina.decisionInkText)
						.frame(maxWidth: .infinity, minHeight: 44)
						.background(MaskinGradient.decisionInk, in: Capsule())
				}
				Button(intent: DismissCycleActivityIntent(flowId: attributes.flowId)) {
					Text("Later")
						.maskinText(.subhead).fontWeight(.semibold)
						.foregroundStyle(MaskinColor.ink3)
						.frame(maxWidth: .infinity, minHeight: 44)
						.background(MaskinSurface.fill, in: Capsule())
				}
				.buttonStyle(.plain)
			}
		}
	}
}

/// One sentence of who is doing what, the lead name bold ("**Writer** is drafting ...").
private struct CycleSummary: View {
	let state: CycleActivityState
	var font: MaskinTextRole = .subhead
	var color: Color

	var body: some View {
		Group {
			if let parts = state.summaryParts {
				Text(parts.actor).bold().foregroundStyle(MaskinColor.ink) + Text(parts.rest)
			} else {
				Text(state.summary)
			}
		}
		.maskinText(font)
		.foregroundStyle(color)
		.lineLimit(2)
	}
}

/// The running bar: signal gradient on the quiet track, as in the mockup.
private struct CycleBar: View {
	let progress: Double

	var body: some View {
		Capsule().fill(MaskinSurface.line)
			.overlay(alignment: .leading) {
				GeometryReader { proxy in
					Capsule().fill(MaskinGradient.ring)
						.frame(width: proxy.size.width * progress)
				}
			}
			.frame(height: 6)
			.accessibilityElement(children: .ignore)
			.accessibilityLabel("\(Int((progress * 100).rounded())) percent")
	}
}

private struct CycleLockScreenView: View {
	let attributes: MaskinCycleAttributes
	let state: CycleActivityState

	var body: some View {
		if state.phase == .needsYou {
			needsYou
		} else {
			running
		}
	}

	/// Ended needing the reader: "NEEDS YOU", the sentence as the headline, Review and Later.
	private var needsYou: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text("NEEDS YOU").maskinText(.microLabel).foregroundStyle(MaskinColor.sigInk)
				Text(state.summary.isEmpty ? state.flowName : state.summary)
					.maskinText(.headline).foregroundStyle(MaskinColor.ink).lineLimit(3)
			}
			CycleActions(attributes: attributes, state: state)
		}
		.accessibilityElement(children: .contain)
	}

	private var running: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			HStack(spacing: MaskinSpace.s7) {
				CycleRing(state: state, size: 52)
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					Text(state.eyebrow)
						.maskinText(.microLabel).foregroundStyle(MaskinColor.ink4).lineLimit(1)
					Text(state.flowName)
						.maskinText(.headline).foregroundStyle(MaskinColor.ink).lineLimit(1)
				}
				Spacer(minLength: MaskinSpace.s4)
				Text("RUNNING")
					.maskinText(.microLabel)
					.foregroundStyle(MaskinColor.sigInk)
					.padding(.horizontal, MaskinSpace.s4)
					.padding(.vertical, MaskinSpace.s2)
					.background(MaskinColor.sigTint, in: RoundedRectangle(cornerRadius: MaskinRadius.key, style: .continuous))
			}
			CycleSummary(state: state, font: .body, color: MaskinColor.ink3)
			CycleBar(progress: state.progress)
		}
		.accessibilityElement(children: .combine)
	}
}
