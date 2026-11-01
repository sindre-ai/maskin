// Maskin's own "ready" sound for the start of a live call, in place of a spoken greeting:
// a relay clicks, a small servo spins up, a latch clicks, then a warm rising-fifth bell (E5 to B5).
// Rendered to samples here so there is no asset to ship. The iOS app ports the same math, so keep
// this in step with the reference synth (about 0.85 s, mono, peak 0.17).

export const MASKIN_READY_DURATION_S = 0.85
export const MASKIN_READY_PEAK = 0.17

// Deterministic noise (same clicks on every platform): xorshift32.
function makeNoise(seed = 0x9e3779b9) {
	let s = seed >>> 0
	return () => {
		s ^= s << 13
		s >>>= 0
		s ^= s >>> 17
		s ^= s << 5
		s >>>= 0
		return (s / 0xffffffff) * 2 - 1
	}
}

// One-pole highpass so the noise reads as a tick.
function makeHighpass(cutoffHz: number, sr: number) {
	const rc = 1 / (2 * Math.PI * cutoffHz)
	const dt = 1 / sr
	const a = rc / (rc + dt)
	let prevIn = 0
	let prevOut = 0
	return (x: number) => {
		const y = a * (prevOut + x - prevIn)
		prevIn = x
		prevOut = y
		return y
	}
}

const expEnv = (t: number, t0: number, tau: number) => (t < t0 ? 0 : Math.exp(-(t - t0) / tau))
const smooth = (x: number) => x * x * (3 - 2 * x)

// Fundamental plus two inharmonic-ish partials, exponential decay.
function bell(t: number, t0: number, f: number, peak: number, tau: number) {
	if (t < t0) return 0
	const e = expEnv(t, t0, tau)
	const attack = smooth(Math.min(1, (t - t0) / 0.004))
	const ph = 2 * Math.PI * (t - t0)
	return (
		peak *
		attack *
		e *
		(Math.sin(ph * f) + 0.35 * Math.sin(ph * f * 2.0) + 0.12 * Math.sin(ph * f * 3.01))
	)
}

export function renderMaskinReady(sr = 44100): Float32Array<ArrayBuffer> {
	const n = Math.round(MASKIN_READY_DURATION_S * sr)
	const out = new Float32Array(n)
	const noise = makeNoise()
	const hp = makeHighpass(1800, sr)

	let servoPhase = 0
	for (let i = 0; i < n; i++) {
		const t = i / sr
		let v = 0

		// 1) Relay click at 0.000 s: 6 ms of high-passed noise, fast decay.
		v += 0.1 * hp(noise()) * expEnv(t, 0, 0.0018) * (t < 0.03 ? 1 : 0)

		// 2) Servo spin-up 0.025 to 0.165 s: a sine sweeping 140 to 430 Hz with a soft in/out
		//    envelope, plus a quiet second harmonic so it reads as a small motor, not a siren.
		if (t >= 0.025 && t < 0.165) {
			const u = (t - 0.025) / 0.14
			const f = 140 + (430 - 140) * u * u
			servoPhase += (2 * Math.PI * f) / sr
			const env = Math.sin(Math.PI * u) ** 1.5
			v += 0.05 * env * (Math.sin(servoPhase) + 0.4 * Math.sin(servoPhase * 2))
		}

		// 3) Latch click at 0.175 s: softer than the first.
		v += 0.06 * hp(noise()) * expEnv(t, 0.175, 0.0015) * (t >= 0.175 && t < 0.2 ? 1 : 0)

		// 4) Bell notes: E5 at 0.200 s, B5 at 0.315 s (a rising fifth), both warm.
		v += bell(t, 0.2, 659.25, 0.09, 0.2)
		v += bell(t, 0.315, 987.77, 0.1, 0.26)

		out[i] = v
	}

	// Fade the last 60 ms to exactly zero so there is never a click at the end.
	const fade = Math.round(0.06 * sr)
	for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade

	// Normalise to a peak of 0.17: loud enough to notice, never startling.
	let peak = 0
	for (const x of out) peak = Math.max(peak, Math.abs(x))
	const gain = peak > 0 ? MASKIN_READY_PEAK / peak : 1
	for (let i = 0; i < n; i++) out[i] *= gain
	return out
}

type AudioContextCtor = typeof AudioContext

/**
 * One AudioContext per call. Create it inside the gesture that starts the call so the
 * browser's autoplay policy lets the sound play later. Null when Web Audio is missing.
 */
export function createChimeContext(): AudioContext | null {
	try {
		const Ctor: AudioContextCtor | undefined =
			window.AudioContext ??
			(window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext
		if (!Ctor) return null
		const ctx = new Ctor()
		void ctx.resume?.()?.catch?.(() => {})
		return ctx
	} catch {
		return null
	}
}

/** Plays the ready sound once on `ctx`, rendered at its sample rate. Never throws. */
export function playMaskinReady(ctx: AudioContext | null): void {
	if (!ctx) return
	try {
		const samples = renderMaskinReady(ctx.sampleRate)
		const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate)
		buffer.copyToChannel(samples, 0)
		const source = ctx.createBufferSource()
		source.buffer = buffer
		source.connect(ctx.destination)
		source.start()
	} catch {
		// A sound is a nicety; a failing audio stack must not touch the call.
	}
}

/** Releases the context at the end of a call. Never throws. */
export function closeChimeContext(ctx: AudioContext | null): void {
	try {
		void ctx?.close?.()?.catch?.(() => {})
	} catch {
		// Already closed.
	}
}
