import Foundation

/// Maskin's own "ready" sound for a live call, as raw samples: a relay click, a small servo spinning
/// up, a latch click, then a warm rising-fifth bell (E5 to B5). About 0.85 s, mono, quiet.
///
/// A direct port of `renderMaskinReady` in the web app's reference synth, so both platforms sound the
/// same; the golden values in the tests come from running that script. Pure, so the shape is tested
/// without a speaker. Change the constants only together with the web copy.
public enum MaskinReadySynth {
	public static let duration: Double = 0.85
	/// The loudest sample, on a scale where 1 is full volume.
	public static let peakAmplitude: Float = 0.17

	/// xorshift32, so the clicks are the same on every platform.
	private struct Noise {
		var state: UInt32 = 0x9e37_79b9
		mutating func next() -> Double {
			state ^= state << 13
			state ^= state >> 17
			state ^= state << 5
			return Double(state) / 4_294_967_295.0 * 2 - 1
		}
	}

	/// One-pole high-pass, so the noise reads as a tick.
	private struct HighPass {
		let a: Double
		var prevIn = 0.0
		var prevOut = 0.0
		init(cutoffHz: Double, sampleRate: Double) {
			let rc = 1 / (2 * Double.pi * cutoffHz)
			a = rc / (rc + 1 / sampleRate)
		}
		mutating func process(_ x: Double) -> Double {
			let y = a * (prevOut + x - prevIn)
			prevIn = x
			prevOut = y
			return y
		}
	}

	private static func expEnv(_ t: Double, _ t0: Double, _ tau: Double) -> Double {
		t < t0 ? 0 : exp(-(t - t0) / tau)
	}

	private static func smooth(_ x: Double) -> Double { x * x * (3 - 2 * x) }

	/// Fundamental plus two inharmonic-ish partials, exponential decay.
	private static func bell(_ t: Double, _ t0: Double, _ f: Double, _ peak: Double, _ tau: Double) -> Double {
		if t < t0 { return 0 }
		let e = expEnv(t, t0, tau)
		let attack = smooth(min(1, (t - t0) / 0.004))
		let ph = 2 * Double.pi * (t - t0)
		return peak * attack * e * (sin(ph * f) + 0.35 * sin(ph * f * 2.0) + 0.12 * sin(ph * f * 3.01))
	}

	/// Mono samples in -1...1 at `sampleRate`.
	public static func samples(sampleRate sr: Double = 44_100) -> [Float] {
		guard sr > 0 else { return [] }
		let n = Int((duration * sr).rounded())
		var out = [Float](repeating: 0, count: n)
		var noise = Noise()
		var highPass = HighPass(cutoffHz: 1800, sampleRate: sr)
		var servoPhase = 0.0

		for i in 0..<n {
			let t = Double(i) / sr
			var v = 0.0

			// 1) Relay click at 0 s: 6 ms of high-passed noise, fast decay.
			v += 0.1 * highPass.process(noise.next()) * expEnv(t, 0, 0.0018) * (t < 0.03 ? 1 : 0)

			// 2) Servo spin-up 0.025 to 0.165 s: a sine sweeping 140 to 430 Hz, soft in and out,
			//    with a quiet second harmonic.
			if t >= 0.025 && t < 0.165 {
				let u = (t - 0.025) / 0.14
				let f = 140 + (430 - 140) * u * u
				servoPhase += 2 * Double.pi * f / sr
				let env = pow(sin(Double.pi * u), 1.5)
				v += 0.05 * env * (sin(servoPhase) + 0.4 * sin(servoPhase * 2))
			}

			// 3) Latch click at 0.175 s: softer than the first.
			v += 0.06 * highPass.process(noise.next()) * expEnv(t, 0.175, 0.0015)
				* (t >= 0.175 && t < 0.2 ? 1 : 0)

			// 4) Bell notes: E5 at 0.200 s, B5 at 0.315 s (a rising fifth).
			v += bell(t, 0.2, 659.25, 0.09, 0.2)
			v += bell(t, 0.315, 987.77, 0.1, 0.26)

			out[i] = Float(v)
		}

		// Fade the last 60 ms to exactly zero so there is never a click at the end.
		let fade = Int((0.06 * sr).rounded())
		for i in 0..<min(fade, n) { out[n - 1 - i] *= Float(i) / Float(fade) }

		// Normalise to the peak: loud enough to notice, never startling.
		let peak = out.map { abs($0) }.max() ?? 0
		let gain = peak > 0 ? peakAmplitude / peak : 1
		return out.map { $0 * gain }
	}
}
