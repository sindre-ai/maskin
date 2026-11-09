import {
	MASKIN_READY_PEAK,
	closeChimeContext,
	createChimeContext,
	playMaskinReady,
	renderMaskinReady,
} from '@/lib/voice-chime'
import { describe, expect, it, vi } from 'vitest'

describe('renderMaskinReady', () => {
	it('lasts about 0.85 s at the given sample rate', () => {
		expect(renderMaskinReady(44100)).toHaveLength(37485)
		expect(renderMaskinReady(48000)).toHaveLength(40800)
	})

	it('peaks at 0.17, below 0.2', () => {
		const out = renderMaskinReady(44100)
		const peak = out.reduce((p, x) => Math.max(p, Math.abs(x)), 0)
		expect(peak).toBeCloseTo(MASKIN_READY_PEAK, 3)
		expect(peak).toBeLessThan(0.2)
	})

	it('starts and ends near silence', () => {
		const out = renderMaskinReady(44100)
		expect(Math.abs(out[0])).toBeLessThan(0.05)
		expect(Math.abs(out[out.length - 1])).toBeLessThan(0.001)
	})

	it('matches the reference synth (maskin-ready-sound.mjs at 44100 Hz)', () => {
		// Values produced by running the reference renderMaskinReady(44100) with node.
		const golden: Array<[number, number]> = [
			[0, -0.030583417043089867],
			[2, 0.0769243836402893],
			[100, -0.0062137446366250515],
			[1000, 1.6063967223090003e-7],
			[3000, 0.005783173255622387],
			[5000, -0.051960092037916183],
			[8820, 0],
			[12000, -0.0007675581728108227],
			[20000, -0.04893682897090912],
			[30000, -0.032166194170713425],
		]
		const out = renderMaskinReady(44100)
		for (const [i, v] of golden) expect(Math.abs(out[i] - v)).toBeLessThan(1e-3)
	})

	it('is deterministic', () => {
		expect(Array.from(renderMaskinReady(44100))).toEqual(Array.from(renderMaskinReady(44100)))
	})
})

describe('playMaskinReady', () => {
	it('plays one buffer rendered at the context sample rate', () => {
		const source = { buffer: null as unknown, connect: vi.fn(), start: vi.fn() }
		const buffer = { copyToChannel: vi.fn() }
		const ctx = {
			sampleRate: 48000,
			destination: {},
			createBuffer: vi.fn(() => buffer),
			createBufferSource: vi.fn(() => source),
		}
		playMaskinReady(ctx as unknown as AudioContext)
		expect(ctx.createBuffer).toHaveBeenCalledWith(1, 40800, 48000)
		expect(source.start).toHaveBeenCalledTimes(1)
	})

	it('never throws without Web Audio or with a broken context', () => {
		expect(() => playMaskinReady(null)).not.toThrow()
		const broken = {
			sampleRate: 44100,
			createBuffer: () => {
				throw new Error('boom')
			},
		}
		expect(() => playMaskinReady(broken as unknown as AudioContext)).not.toThrow()
		expect(() => closeChimeContext(null)).not.toThrow()
	})

	it('createChimeContext returns null when AudioContext is missing', () => {
		vi.stubGlobal('AudioContext', undefined)
		expect(createChimeContext()).toBeNull()
		vi.unstubAllGlobals()
	})
})
