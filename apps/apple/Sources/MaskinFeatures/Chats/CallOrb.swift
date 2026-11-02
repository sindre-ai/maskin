import MaskinCore
import MaskinDesign
import SwiftUI

/// A soft orb that moves with the sound of the call: your microphone while you speak, the agent's
/// voice while it speaks, a slow breath while connecting or thinking, still and dim when muted. The
/// level comes from a `CallLevelMeter` that the view reads on every frame, so the 20 Hz stats never
/// re-render anything. With Reduce Motion it is a still orb that only changes opacity with the state.
struct CallOrb: View {
	let state: CallOrbState
	/// Nil for a driver that has no levels (the dictation call): the orb then moves on a gentle
	/// stand-in so it still reads as alive while someone is talking.
	var meter: CallLevelMeter?
	var size: CGFloat = callOrbSize

	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var driver = CallOrbDriver()

	var body: some View {
		TimelineView(.animation(paused: reduceMotion || state == .muted)) { context in
			let frame = driver.frame(at: context.date, state: state, meter: meter, compact: size < 60)
			Canvas { canvas, canvasSize in
				CallOrbPainter.draw(frame, style: style, in: &canvas, size: canvasSize)
			}
		}
		.frame(width: size, height: size)
		.opacity(restingOpacity)
		.animation(MaskinMotion.fade, value: state)
		.accessibilityElement()
		.accessibilityLabel(state.accessibilityLabel)
	}

	private var style: CallOrbStyle {
		switch state {
		case .listening, .speaking: CallOrbStyle(.live)
		case .connecting, .thinking: CallOrbStyle(.calm)
		case .muted: CallOrbStyle(.muted)
		}
	}

	/// Muted is dimmed; with Reduce Motion the state shows as a gentle change of strength instead.
	private var restingOpacity: Double {
		switch state {
		case .muted: 0.35
		case .connecting, .thinking: reduceMotion ? 0.6 : 1
		case .listening: reduceMotion ? 0.8 : 1
		case .speaking: 1
		}
	}
}

/// The default size of the orb on the call card, bigger than the avatar it sits behind so a swell
/// shows around it.
let callOrbSize = MaskinSpace.s14 * 2

/// One frame of the orb, already smoothed: how big, how wobbly, how bright.
struct CallOrbFrame: Equatable {
	var level = 0.0
	var breath = 0.0
	var time = 0.0
	/// Below about 60 pt the finest ripple and the halo's blur would turn to mush, so they are dropped.
	var compact = false
}

/// Holds what must persist from one frame to the next (the smoothed level), outside SwiftUI state so
/// that advancing it while drawing does not invalidate the view.
@MainActor
final class CallOrbDriver {
	private var smoother = AudioLevelSmoother()
	private var lastDate: Date?

	func frame(at date: Date, state: CallOrbState, meter: CallLevelMeter?, compact: Bool) -> CallOrbFrame {
		let t = date.timeIntervalSinceReferenceDate
		let dt = lastDate.map { min(0.1, max(0, date.timeIntervalSince($0))) } ?? 0
		lastDate = date
		let target: Double
		switch (state.levelSource, meter) {
		case (.microphone, let meter?): target = AudioLevelSmoother.shaped(meter.input)
		case (.agent, let meter?): target = AudioLevelSmoother.shaped(meter.output)
		case (.microphone, nil), (.agent, nil): target = 0.3 + 0.2 * sin(t * 5.1) * sin(t * 2.3)
		case (.none, _): target = 0
		}
		let level = smoother.update(target: target, dt: dt)
		// Connecting and thinking breathe slowly (about 4 s a cycle); the rest hold still.
		let breathes = state == .connecting || state == .thinking
		return CallOrbFrame(level: level, breath: breathes ? 0.5 + 0.5 * sin(t * 2 * .pi / 4) : 0, time: t,
			compact: compact)
	}
}

/// The drawing, apart from the view so a preview or a test can use it.
enum CallOrbPainter {
	private static let points = 72

	static func draw(_ frame: CallOrbFrame, style: CallOrbStyle, in canvas: inout GraphicsContext, size: CGSize) {
		let center = CGPoint(x: size.width / 2, y: size.height / 2)
		let half = min(size.width, size.height) / 2
		// At rest the body fills about 70% of the box; a full-level swell takes it to about 95%.
		let base = half * (0.62 + 0.06 * frame.breath + 0.2 * frame.level)

		// The halo: a soft glow that grows with the sound.
		canvas.drawLayer { layer in
			layer.addFilter(.blur(radius: half * (frame.compact ? 0.12 : 0.22)))
			let glow = base * (1.12 + 0.12 * frame.level)
			layer.fill(
				Path(ellipseIn: CGRect(x: center.x - glow, y: center.y - glow, width: glow * 2, height: glow * 2)),
				with: .color(style.glow.opacity(0.28 + 0.3 * frame.level + 0.08 * frame.breath)))
		}

		// A second, paler blob drifting the other way gives the body depth.
		canvas.fill(
			blob(center: center, radius: base * 1.04, wobble: 0.05 + 0.1 * frame.level, time: -frame.time * 0.8, phase: 1.7, fine: !frame.compact),
			with: .color((style.gradientColors.first ?? .clear).opacity(0.45)))
		canvas.fill(
			blob(center: center, radius: base, wobble: 0.04 + 0.12 * frame.level, time: frame.time, phase: 0, fine: !frame.compact),
			with: .radialGradient(
				Gradient(colors: style.gradientColors),
				center: CGPoint(x: center.x - base * 0.25, y: center.y - base * 0.3),
				startRadius: 0, endRadius: base * 1.3))
	}

	/// A circle whose edge ripples: three sine harmonics, so it reads as liquid rather than a wheel.
	static func blob(center: CGPoint, radius: CGFloat, wobble: Double, time: Double, phase: Double, fine: Bool = true) -> Path {
		var path = Path()
		for step in 0...points {
			let angle = Double(step) / Double(points) * 2 * .pi
			let ripple =
				0.5 * sin(2 * angle + time * 1.3 + phase) + 0.3 * sin(3 * angle - time * 1.7 + phase)
				+ (fine ? 0.2 : 0) * sin(5 * angle + time * 2.3 + phase)
			let r = radius * (1 + wobble * ripple)
			let point = CGPoint(x: center.x + CGFloat(cos(angle)) * r, y: center.y + CGFloat(sin(angle)) * r)
			if step == 0 { path.move(to: point) } else { path.addLine(to: point) }
		}
		path.closeSubpath()
		return path
	}
}

#if DEBUG
/// A fake level source for the previews: a speech-like pattern, so every state can be seen.
private final class PreviewMeter: @unchecked Sendable {
	let meter = CallLevelMeter()
	private var timer: Timer?
	init() {
		timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [meter] _ in
			let t = Date.timeIntervalSinceReferenceDate
			let syllable = max(0, sin(t * 6)) * max(0, sin(t * 1.7 + 1))
			meter.record(input: 0.25 * syllable, output: 0.3 * syllable)
		}
	}
	deinit { timer?.invalidate() }
}

private struct CallOrbGallery: View {
	@State private var source = PreviewMeter()
	var body: some View {
		let states: [CallOrbState] = [.connecting, .listening, .thinking, .speaking, .muted]
		LazyVGrid(columns: [GridItem(.adaptive(minimum: 140))], spacing: MaskinSpace.s8) {
			ForEach(states, id: \.accessibilityLabel) { state in
				VStack {
					CallOrb(state: state, meter: source.meter, size: 128)
					Text(state.accessibilityLabel).maskinText(.caption).foregroundStyle(MaskinColor.ink3)
				}
			}
		}
		.padding()
		.background(MaskinSurface.card)
	}
}

#Preview("Orb states, light") { CallOrbGallery().preferredColorScheme(.light) }
#Preview("Orb states, dark") { CallOrbGallery().preferredColorScheme(.dark) }
// Reduce Motion: turn it on in the preview's Accessibility environment overrides.
#endif
