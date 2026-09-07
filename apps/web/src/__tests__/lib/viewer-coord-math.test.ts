import {
	ZOOM_MAX,
	ZOOM_MIN,
	clampZoom,
	computeFit,
	docToStage,
	stageToDoc,
	zoomAt,
	zoomStep,
} from '@/lib/viewer-coord-math'
import { describe, expect, it } from 'vitest'

const ROUND_TRIP_TOLERANCE_PX = 0.5

function pseudoRandom(seed: number): () => number {
	let s = seed >>> 0
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0
		return s / 0xffffffff
	}
}

describe('viewer-coord-math', () => {
	describe('clampZoom', () => {
		it('clamps below the min', () => {
			expect(clampZoom(0.01)).toBe(ZOOM_MIN)
			expect(clampZoom(-4)).toBe(ZOOM_MIN)
		})

		it('clamps above the max', () => {
			expect(clampZoom(10)).toBe(ZOOM_MAX)
			expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(ZOOM_MAX)
		})

		it('passes through values in range', () => {
			expect(clampZoom(1)).toBe(1)
			expect(clampZoom(2.5)).toBeCloseTo(2.5, 6)
		})

		it('replaces NaN with the min', () => {
			expect(clampZoom(Number.NaN)).toBe(ZOOM_MIN)
		})
	})

	describe('computeFit', () => {
		it('picks the min of the width and height ratios (letterbox)', () => {
			// Wide doc in a square viewport: width ratio dominates.
			expect(computeFit({ w: 1920, h: 1080 }, { w: 960, h: 960 })).toBeCloseTo(960 / 1920, 6)
			// Tall doc in a square viewport: height ratio dominates.
			expect(computeFit({ w: 800, h: 2000 }, { w: 1000, h: 1000 })).toBeCloseTo(1000 / 2000, 6)
		})

		it('never exceeds the [ZOOM_MIN, ZOOM_MAX] range', () => {
			// Would fit at k = 100 without a clamp.
			expect(computeFit({ w: 10, h: 10 }, { w: 1000, h: 1000 })).toBe(ZOOM_MAX)
			// Would fit at k = 0.005 without a clamp.
			expect(computeFit({ w: 10_000, h: 10_000 }, { w: 50, h: 50 })).toBe(ZOOM_MIN)
		})

		it('returns the min zoom on degenerate inputs', () => {
			expect(computeFit({ w: 0, h: 100 }, { w: 100, h: 100 })).toBe(ZOOM_MIN)
			expect(computeFit({ w: 100, h: 100 }, { w: 0, h: 100 })).toBe(ZOOM_MIN)
		})
	})

	describe('zoomStep', () => {
		it('scales by 1.25 in and 1/1.25 out', () => {
			expect(zoomStep(1, 'in')).toBeCloseTo(1.25, 6)
			expect(zoomStep(1, 'out')).toBeCloseTo(1 / 1.25, 6)
		})

		it('clamps at the boundaries', () => {
			expect(zoomStep(ZOOM_MAX, 'in')).toBe(ZOOM_MAX)
			expect(zoomStep(ZOOM_MIN, 'out')).toBe(ZOOM_MIN)
		})
	})

	describe('docToStage / stageToDoc round-trip', () => {
		// Explicit acceptance criterion: stageToDoc(docToStage(p, D, k), D, k) === p
		// within 0.5px. Property test over a spread of D, k, p.
		it('round-trips within 0.5px for arbitrary D, k, p', () => {
			const rand = pseudoRandom(0xa5844ca3)
			const cases = 500
			for (let i = 0; i < cases; i++) {
				const doc = { w: 100 + rand() * 10_000, h: 100 + rand() * 10_000 }
				const k = ZOOM_MIN + rand() * (ZOOM_MAX - ZOOM_MIN)
				const pDoc = { x: rand(), y: rand() }
				const pStage = docToStage(pDoc, doc, k)
				const pRound = stageToDoc(pStage, doc, k)
				// Compare in stage px so the 0.5px tolerance is meaningful.
				const stageDx = Math.abs(pRound.x - pDoc.x) * doc.w * k
				const stageDy = Math.abs(pRound.y - pDoc.y) * doc.h * k
				expect(stageDx).toBeLessThan(ROUND_TRIP_TOLERANCE_PX)
				expect(stageDy).toBeLessThan(ROUND_TRIP_TOLERANCE_PX)
			}
		})

		it('handles the pin at doc origin', () => {
			const doc = { w: 1440, h: 900 }
			expect(docToStage({ x: 0, y: 0 }, doc, 0.5)).toEqual({ x: 0, y: 0 })
			expect(stageToDoc({ x: 0, y: 0 }, doc, 0.5)).toEqual({ x: 0, y: 0 })
		})

		it('handles the pin at doc corner', () => {
			const doc = { w: 1440, h: 900 }
			const k = 0.75
			const stage = docToStage({ x: 1, y: 1 }, doc, k)
			expect(stage).toEqual({ x: 1440 * k, y: 900 * k })
			expect(stageToDoc(stage, doc, k)).toEqual({ x: 1, y: 1 })
		})
	})

	describe('zoomAt', () => {
		// After zooming, the doc point that was under the cursor before must
		// remain under the cursor after — i.e. (scroll + cursor) / k invariant.
		it('keeps the cursor doc-point fixed under the mouse', () => {
			const cursor = { x: 640, y: 360 }
			const scroll = { x: 200, y: 100 }
			const prevK = 1
			const beforeDoc = { x: (scroll.x + cursor.x) / prevK, y: (scroll.y + cursor.y) / prevK }
			for (const factor of [1.25, 0.5, 2, 1 / 1.25]) {
				const result = zoomAt(prevK, prevK * factor, cursor, scroll)
				const afterDoc = {
					x: (result.scroll.x + cursor.x) / result.k,
					y: (result.scroll.y + cursor.y) / result.k,
				}
				expect(afterDoc.x).toBeCloseTo(beforeDoc.x, 6)
				expect(afterDoc.y).toBeCloseTo(beforeDoc.y, 6)
			}
		})

		it('clamps k to the zoom range', () => {
			const result = zoomAt(1, 100, { x: 0, y: 0 }, { x: 0, y: 0 })
			expect(result.k).toBe(ZOOM_MAX)
		})
	})
})
