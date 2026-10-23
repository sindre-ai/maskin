import MaskinDesign
import SwiftUI

/// Three red bars that rise and fall while the microphone listens: 3×18 each, an 0.8s cycle
/// staggered by 0.15s per bar. Still under Reduce Motion. Spec 7 §1 → Dictation state.
struct RecordingBars: View {
	var active = true
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	private static let barWidth: CGFloat = MaskinSpace.s1 + 1
	private static let barHeight: CGFloat = MaskinSpace.s10
	private static let period: Double = 0.8
	private static let stagger: Double = MaskinDuration.d150

	var body: some View {
		let animating = active && !reduceMotion
		TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !animating)) { context in
			let time = context.date.timeIntervalSinceReferenceDate
			HStack(alignment: .center, spacing: MaskinSpace.s1 + 0.5) {
				ForEach(0..<3, id: \.self) { index in
					let phase = (time - Double(index) * Self.stagger) / Self.period * 2 * .pi
					let scale = animating ? 0.4 + 0.6 * (0.5 + 0.5 * sin(phase)) : 0.7
					RoundedRectangle(cornerRadius: MaskinRadius.tag, style: .continuous)
						.fill(MaskinColor.dangerMic)
						.frame(width: Self.barWidth, height: Self.barHeight * CGFloat(scale))
				}
			}
			.frame(height: Self.barHeight)
		}
		.frame(height: MaskinSpace.touchMin - MaskinSpace.s2)
		.accessibilityLabel("Listening")
	}
}

/// The left of the composer row while dictating: discard, then the bars. Discard gives back the
/// text from before the mic opened. The field sits between this and `ComposerDictationDone`, in
/// the same slot as when typing, so it keeps focus and the keyboard does not move.
struct ComposerDictationLeading: View {
	let onDiscard: () -> Void

	var body: some View {
		DictationDiscardButton(size: MaskinComposer.control, action: onDiscard)
			.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
		RecordingBars()
	}
}

/// The right of the composer row while dictating.
struct ComposerDictationDone: View {
	let action: () -> Void

	var body: some View {
		DictationDoneButton(size: MaskinComposer.control, action: action)
			.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
	}
}
