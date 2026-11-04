import { createSegmenter } from '@/lib/speech-segmenter'
import { describe, expect, it } from 'vitest'

describe('createSegmenter', () => {
	it('cuts once speech is followed by enough silence', () => {
		const seg = createSegmenter(0, { silenceMs: 700 })
		expect(seg.push(0.1, 100)).toBeNull()
		expect(seg.push(0.001, 500)).toBeNull()
		expect(seg.push(0.001, 800)).toBe('cut')
		expect(seg.hasVoice()).toBe(true)
	})

	it('cuts at a short breath once the phrase is long enough', () => {
		const seg = createSegmenter(0, { silenceMs: 700, softCutMs: 2_000, softSilenceMs: 150 })
		expect(seg.push(0.1, 2_100)).toBeNull()
		expect(seg.push(0.001, 2_200)).toBeNull()
		expect(seg.push(0.001, 2_300)).toBe('cut')
	})

	it('does not cut a short phrase at a short breath', () => {
		const seg = createSegmenter(0, { silenceMs: 700, softCutMs: 2_000, softSilenceMs: 150 })
		expect(seg.push(0.1, 500)).toBeNull()
		expect(seg.push(0.001, 700)).toBeNull()
	})

	it('does not cut on silence alone', () => {
		const seg = createSegmenter(0, { silenceMs: 700, maxSegmentMs: 15_000 })
		expect(seg.push(0, 5_000)).toBeNull()
		expect(seg.hasVoice()).toBe(false)
	})

	it('discards a segment with no speech once it reaches the cap', () => {
		const seg = createSegmenter(0, { maxSegmentMs: 1_000 })
		expect(seg.push(0, 1_000)).toBe('discard')
	})

	it('cuts a speaker who never pauses at the cap', () => {
		const seg = createSegmenter(0, { maxSegmentMs: 1_000 })
		expect(seg.push(0.1, 500)).toBeNull()
		expect(seg.push(0.1, 1_000)).toBe('cut')
	})

	it('starts clean after a reset', () => {
		const seg = createSegmenter(0)
		seg.push(0.1, 100)
		seg.reset(200)
		expect(seg.hasVoice()).toBe(false)
		expect(seg.push(0, 1_000)).toBeNull()
	})
})
