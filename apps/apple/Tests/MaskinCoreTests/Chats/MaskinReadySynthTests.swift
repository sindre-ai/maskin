import Testing

@testable import MaskinCore

@Suite("MaskinReadySynth") struct MaskinReadySynthTests {
	@Test("it is about 0.85 s long")
	func length() {
		#expect(MaskinReadySynth.samples(sampleRate: 44_100).count == 37_485)
		#expect(MaskinReadySynth.samples(sampleRate: 48_000).count == 40_800)
	}

	@Test("it is quiet: the peak is 0.17, below 0.2")
	func peak() {
		let peak = MaskinReadySynth.samples().map { abs($0) }.max() ?? 0
		#expect(abs(peak - 0.17) < 1e-3)
		#expect(peak < 0.2)
	}

	@Test("its last samples fade to zero, so there is no click at the end")
	func edges() {
		let samples = MaskinReadySynth.samples()
		#expect(abs(samples.last ?? 1) < 1e-3)
		#expect(abs(samples[samples.count - 2]) < 1e-3)
	}

	@Test("it is the same every time")
	func deterministic() {
		#expect(MaskinReadySynth.samples() == MaskinReadySynth.samples())
	}

	@Test("it matches the web reference synth sample for sample at 44.1 kHz")
	func matchesTheWebReference() {
		// Values from running `renderMaskinReady()` in maskin-ready-sound.mjs.
		let golden: [Int: Float] = [
			0: -0.030583, 1: -0.010471, 2: 0.076924, 100: -0.006214, 1000: 0, 2000: -0.015584,
			8820: 0, 12000: -0.000768, 20000: -0.048937, 30000: -0.032166, 37000: -0.000008,
		]
		let samples = MaskinReadySynth.samples(sampleRate: 44_100)
		for (index, value) in golden {
			#expect(abs(samples[index] - value) < 1e-3, "sample \(index)")
		}
	}

	@Test("a sample rate of zero gives nothing")
	func noRate() {
		#expect(MaskinReadySynth.samples(sampleRate: 0).isEmpty)
	}
}
