import { describe, expect, it } from 'vitest'
import { EMPTY_RESPONSE_SHAPE, measureResponseShape } from '../response-shape'

describe('measureResponseShape', () => {
	it('counts rows in the row array of structuredContent', () => {
		const shape = measureResponseShape(undefined, {
			objects: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
		})
		expect(shape.rowCount).toBe(3)
	})

	it('picks the longest top-level array when several are present', () => {
		// A list response carries its rows alongside smaller arrays (facets,
		// a hero-card slice). The rows are what a size question is about.
		const shape = measureResponseShape(undefined, {
			facets: [{ k: 1 }],
			objects: [{ id: 'a' }, { id: 'b' }],
		})
		expect(shape.rowCount).toBe(2)
	})

	it('reports rowCount null for a response with no row array', () => {
		// Null, not 0: "not a list tool" must stay distinguishable from "a list
		// tool that returned nothing", which is the interesting case.
		const shape = measureResponseShape(undefined, { id: 'a', title: 'x' })
		expect(shape.rowCount).toBeNull()
		expect(shape.maxRowBytes).toBeNull()
	})

	it('reports rowCount 0 with null maxRowBytes for an empty row array', () => {
		const shape = measureResponseShape(undefined, { objects: [] })
		expect(shape.rowCount).toBe(0)
		expect(shape.maxRowBytes).toBeNull()
	})

	it('reports the largest single row, not the average', () => {
		const shape = measureResponseShape(undefined, {
			objects: [{ id: 'a' }, { id: 'b', content: 'x'.repeat(500) }],
		})
		expect(shape.maxRowBytes).toBeGreaterThan(500)
	})

	it('ranks field names by total bytes across rows, heaviest first', () => {
		const shape = measureResponseShape(undefined, {
			objects: [
				{ id: 'a', content: 'x'.repeat(200), title: 'hi' },
				{ id: 'b', content: 'y'.repeat(200), title: 'yo' },
			],
		})
		expect(shape.topFields[0]).toBe('content')
		expect(shape.topFields).toContain('title')
		expect(shape.topFieldBytes).toHaveLength(shape.topFields.length)
		expect(shape.topFieldBytes[0]).toBeGreaterThan(400)
	})

	it('counts content blocks', () => {
		const shape = measureResponseShape([{ type: 'text', text: 'a' }], undefined)
		expect(shape.contentBlockCount).toBe(1)
	})

	it('reports contentBlockCount null when content is not an array', () => {
		expect(measureResponseShape(undefined, undefined).contentBlockCount).toBeNull()
	})

	// ── Privacy contract ────────────────────────────────────────────────
	// The whole event is only safe because nothing but names and counts
	// leaves this function. These are the assertions that keep it that way.

	it('never emits a field VALUE', () => {
		const secret = 'Acquire the Nakatomi account'
		const shape = measureResponseShape([{ type: 'text', text: secret }], {
			objects: [{ id: 'a', title: secret, content: secret }],
		})
		expect(JSON.stringify(shape)).not.toContain('Nakatomi')
	})

	it('drops non-identifier field names', () => {
		// A workspace-authored `data` jsonb can have sentences for keys. Those
		// are the free text this event exists to exclude, arriving disguised
		// as a schema field.
		const shape = measureResponseShape(undefined, {
			rows: [{ 'Acquire the Nakatomi account': 1, id: 'a' }],
		})
		expect(shape.topFields).toEqual(['id'])
	})

	it('attributes nothing for rows that are bare strings', () => {
		// No field names to attribute to — and the string's content must not
		// become one.
		const shape = measureResponseShape(undefined, { rows: ['a secret title'] })
		expect(shape.rowCount).toBe(1)
		expect(shape.topFields).toEqual([])
	})

	it('caps the number of reported field names', () => {
		const row: Record<string, number> = {}
		for (let i = 0; i < 40; i++) row[`f${i}`] = i
		expect(measureResponseShape(undefined, { rows: [row] }).topFields.length).toBeLessThanOrEqual(8)
	})

	it('returns the empty shape rather than throwing on a circular payload', () => {
		const row: Record<string, unknown> = { id: 'a' }
		row.self = row
		const shape = measureResponseShape(undefined, { rows: [row] })
		// Measurement degrades; it must not cost the tool call.
		expect(shape.rowCount).toBe(1)
		expect(shape.maxRowBytes).toBe(0)
	})

	it('exposes an empty shape constant with no measurements', () => {
		expect(EMPTY_RESPONSE_SHAPE.rowCount).toBeNull()
		expect(EMPTY_RESPONSE_SHAPE.topFields).toEqual([])
	})

	it('flags shapeError when a row cannot be serialized', () => {
		const row: Record<string, unknown> = { id: 'a' }
		row.self = row
		// Without this flag the fallback below is byte-identical to a correct
		// measurement of a tool with no row array, and a query cannot tell a
		// broken row from a legitimately empty one.
		expect(measureResponseShape(undefined, { rows: [row] }).shapeError).toBe(true)
	})

	it('leaves shapeError false for a clean measurement', () => {
		expect(measureResponseShape(undefined, { rows: [{ id: 'a' }] }).shapeError).toBe(false)
		expect(measureResponseShape(undefined, { id: 'a' }).shapeError).toBe(false)
	})

	it('bounds row serialization to the sample window on a huge row array', () => {
		// The sampling cap exists so measurement is not an O(payload) serialize on
		// every tool call. maxRowBytes previously serialized (and spread) the whole
		// array, which is both the cost the cap forbids and a RangeError on a large
		// enough response — silently discarding shape data for the biggest ones.
		const rows = Array.from({ length: 200_000 }, (_, i) => ({ id: String(i) }))
		const shape = measureResponseShape(undefined, { objects: rows })
		expect(shape.rowCount).toBe(200_000)
		expect(shape.maxRowBytes).toBeGreaterThan(0)
		expect(shape.shapeError).toBe(false)
	})

	it('derives maxRowBytes from the sampled window, not the whole array', () => {
		// A fat row beyond the sample is not reported: maxRowBytes is a lower
		// bound on row width, which is all "too many rows vs rows too fat" needs.
		const rows: Record<string, unknown>[] = Array.from({ length: 40 }, () => ({ id: 'a' }))
		rows[39] = { id: 'a', content: 'x'.repeat(5_000) }
		expect(measureResponseShape(undefined, { objects: rows }).maxRowBytes).toBeLessThan(1_000)
	})
})
