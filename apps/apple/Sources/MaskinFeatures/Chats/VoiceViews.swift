import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// What the composer's right-hand side and body are doing with voice.
enum ComposerVoiceState: Equatable {
	/// Typing: a mic and a live button while the field is empty, Send once there is text.
	case idle
	/// Dictating into the field: the right side shows a waveform and a checkmark to finish.
	case dictating
	/// A live voice conversation: the card gives way to the live panel.
	case live(LiveVoicePhase)
}

/// A few bars that rise and fall while `active`, still otherwise (and under Reduce Motion).
struct VoiceWaveform: View {
	var active = true
	var bars = 7
	var height: CGFloat = 40
	var barWidth: CGFloat = 4
	var tint: Color = MaskinColor.accent
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	/// The bars' resting silhouette: tall in the middle, short at the edges.
	private func profile(_ index: Int) -> CGFloat {
		let middle = CGFloat(bars - 1) / 2
		return 1 - abs(CGFloat(index) - middle) / (middle + 1) * 0.65
	}

	var body: some View {
		TimelineView(.animation(minimumInterval: 1.0 / 24, paused: !active || reduceMotion)) { context in
			let time = context.date.timeIntervalSinceReferenceDate
			HStack(spacing: barWidth) {
				ForEach(0..<bars, id: \.self) { index in
					let wave = active ? 0.45 + 0.55 * abs(sin(time * 3.2 + Double(index) * 0.8)) : 0.3
					Capsule().fill(tint)
						.frame(width: barWidth, height: max(barWidth, height * profile(index) * CGFloat(wave)))
				}
			}
			.frame(height: height)
		}
		.accessibilityHidden(true)
	}
}

/// The composer while talking with an agent live: who is speaking, a waveform, what was just heard,
/// and the controls: attach, mute the mic, and a prominent End.
struct LiveVoicePanel: View {
	let phase: LiveVoicePhase
	let agentName: String
	/// What you are saying (or just said), as it is recognised.
	var transcript = ""
	var muted = false
	var onToggleMute: () -> Void = {}
	var onEnd: () -> Void = {}
	var onInterrupt: () -> Void = {}

	private let shape = RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous)

	var body: some View {
		VStack(spacing: MaskinSpace.s7) {
			VStack(spacing: MaskinSpace.s3) {
				VoiceWaveform(active: phase != .thinking && !muted, bars: 9, height: 44, tint: tint)
				Text(title).maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
				Text(subtitle).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
					.lineLimit(2).multilineTextAlignment(.center)
			}
			.frame(maxWidth: .infinity)
			.padding(.top, MaskinSpace.s8)
			.padding(.horizontal, MaskinSpace.s8)
			.contentShape(Rectangle())
			.onTapGesture { if phase == .speaking { onInterrupt() } }
			controls
		}
		.background(MaskinSurface.card, in: shape)
		.overlay(shape.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.accessibilityElement(children: .contain)
	}

	private var tint: Color { phase == .speaking ? MaskinColor.accent : MaskinColor.ink3 }

	private var title: String {
		switch phase {
		case .listening: muted ? "Mic is off" : "Listening…"
		case .thinking: "\(agentName) is working…"
		case .speaking: "\(agentName) is speaking"
		}
	}

	private var subtitle: String {
		switch phase {
		case .listening: muted ? "Tap the mic to talk" : (transcript.isEmpty ? "Say something. It sends when you pause." : transcript)
		case .thinking: transcript.isEmpty ? "Your message is sent" : transcript
		case .speaking: "Tap to interrupt"
		}
	}

	private var controls: some View {
		HStack(spacing: MaskinSpace.s3) {
			Spacer(minLength: 0)
			Button(action: onToggleMute) {
				Image(systemName: muted ? "mic.slash.fill" : "mic.fill")
					.font(.system(size: MaskinFontSize.t16, weight: .medium))
					.foregroundStyle(muted ? MaskinColor.danger : MaskinColor.ink3)
					.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
					.background(MaskinSurface.fill, in: Circle())
			}
			.buttonStyle(.plain)
			.accessibilityLabel(muted ? "Turn the microphone on" : "Mute the microphone")
			Button {
				MaskinHaptics.play(.medium)
				onEnd()
			} label: {
				Label("End", systemImage: "xmark")
					.maskinText(.subhead).fontWeight(.semibold)
					.foregroundStyle(MaskinSurface.onInverse)
					.padding(.horizontal, MaskinSpace.s10)
					.frame(height: MaskinSpace.touchMin)
					.background(MaskinSurface.inverse, in: Capsule())
			}
			.buttonStyle(.plain)
			.accessibilityLabel("End the live conversation")
			Spacer(minLength: 0)
		}
		.padding(.horizontal, MaskinSpace.s5)
		.padding(.bottom, MaskinSpace.s5)
	}
}
