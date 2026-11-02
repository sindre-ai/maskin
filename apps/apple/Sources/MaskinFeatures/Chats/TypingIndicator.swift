import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One meaning per indicator (spec 7 §3): dots mean an agent is composing a reply, bars mean it is
/// working on a task. Both pause while off screen and hold still under Reduce Motion.

/// Three 7pt `fg5` dots pulsing over 1s, staggered 0.2s.
struct TypingDots: View {
	var color: Color = MaskinColor.ink5
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var onScreen = false

	private static let dot: CGFloat = MaskinSpace.s8 / 2
	private static let period = 1.0
	private static let stagger = 0.2

	var body: some View {
		HStack(spacing: MaskinSpace.s2) {
			ForEach(0..<3, id: \.self) { index in
				if onScreen && !reduceMotion {
					Circle().fill(color).frame(width: Self.dot, height: Self.dot)
						.phaseAnimator([0.3, 1.0]) { view, phase in
							view.opacity(phase).scaleEffect(0.85 + 0.15 * phase)
						} animation: { _ in
							.easeInOut(duration: Self.period / 2).delay(Double(index) * Self.stagger)
						}
				} else {
					Circle().fill(color).frame(width: Self.dot, height: Self.dot).opacity(0.7)
				}
			}
		}
		.onAppear { onScreen = true }
		.onDisappear { onScreen = false }
		.accessibilityHidden(true)
	}
}

/// An agent composing a reply: the dots inside an agent-shaped bubble, with the name above.
struct TypingIndicator: View {
	let agent: ChatParticipant

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			MessageHeader(name: agent.name, kind: agent.kind, seed: agent.id, time: nil)
			TypingDots()
				.padding(.vertical, MaskinSpace.s8 + MaskinSpace.s1)
				.padding(.horizontal, MaskinSpace.s10 - MaskinSpace.s1)
				.background(MaskinSurface.card, in: BubbleShape.agent)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("\(agent.name) is typing")
	}
}

/// Three 2.5pt `sig` equaliser bars over 0.8s, staggered 0.15s: an agent working on a task.
struct EqualiserBars: View {
	var color: Color = MaskinColor.sig
	var height: CGFloat = MaskinSpace.s6
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var onScreen = false

	private static let bar: CGFloat = MaskinSpace.s5 / 4
	private static let period = 0.8
	private static let stagger = 0.15

	var body: some View {
		HStack(alignment: .bottom, spacing: MaskinSpace.s1) {
			ForEach(0..<3, id: \.self) { index in
				if onScreen && !reduceMotion {
					bar
						.phaseAnimator([0.35, 1.0]) { view, phase in
							view.frame(height: height * phase)
						} animation: { _ in
							.easeInOut(duration: Self.period / 2).delay(Double(index) * Self.stagger)
						}
				} else {
					bar.frame(height: height * [0.5, 0.9, 0.65][index])
				}
			}
		}
		.frame(height: height, alignment: .bottom)
		.onAppear { onScreen = true }
		.onDisappear { onScreen = false }
		.accessibilityHidden(true)
	}

	private var bar: some View {
		RoundedRectangle(cornerRadius: MaskinRadius.tag, style: .continuous).fill(color).frame(width: Self.bar)
	}
}

/// The 8×16 `fg4` caret blinking at the end of a reply that is still streaming.
struct BlinkingCaret: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var onScreen = false

	var body: some View {
		let shape = RoundedRectangle(cornerRadius: MaskinRadius.tag, style: .continuous).fill(MaskinColor.ink4)
			.frame(width: MaskinSpace.s4, height: MaskinSpace.s9)
		Group {
			if onScreen && !reduceMotion {
				shape.phaseAnimator([1.0, 0.0]) { view, phase in view.opacity(phase) } animation: { _ in
					.easeInOut(duration: MaskinDuration.slide + MaskinDuration.d200)
				}
			} else {
				shape
			}
		}
		.onAppear { onScreen = true }
		.onDisappear { onScreen = false }
		.accessibilityHidden(true)
	}
}
