import { describe, expect, it } from 'vitest'
import { addCopenhagenTimesToResponse, withCopenhagenTimes } from '../copenhagen-times'

describe('withCopenhagenTimes', () => {
	it('adds a Copenhagen sibling next to a stored UTC time and keeps the stored value', () => {
		const out = withCopenhagenTimes({ createdAt: '2026-11-17T20:00:00.000Z', title: 'x' })
		expect(out).toEqual({
			createdAt: '2026-11-17T20:00:00.000Z',
			createdAt_copenhagen: '2026-11-17 21:00',
			title: 'x',
		})
	})

	it('follows summer time', () => {
		expect(withCopenhagenTimes({ due_at: '2026-07-17T20:00:00Z' })).toMatchObject({
			due_at_copenhagen: '2026-07-17 22:00',
		})
	})

	it('reaches rows inside nested lists and objects', () => {
		const out = withCopenhagenTimes({ rows: [{ updatedAt: '2026-11-17T23:30:00.000Z' }] })
		expect(out.rows[0]).toMatchObject({ updatedAt_copenhagen: '2026-11-18 00:30' })
	})

	it('leaves other strings, dates without a time, and stored metadata and config alone', () => {
		const input = {
			title: '2026-11-17T20:00:00.000Z is not a key worth converting in prose',
			day: '2026-11-17',
			note: 'at 2026-11-17T20:00:00.000Z',
			metadata: { due: '2026-11-17T20:00:00.000Z' },
			config: { scheduled_at: '2026-11-17T20:00:00.000Z' },
			list: ['2026-11-17T20:00:00.000Z'],
		}
		expect(withCopenhagenTimes(input)).toEqual(input)
	})
})

describe('addCopenhagenTimesToResponse', () => {
	it('covers the text a voice call reads and structuredContent', () => {
		const payload = { rows: [{ next_run: '2026-11-17T20:00:00.000Z' }] }
		const out = addCopenhagenTimesToResponse({
			content: [{ type: 'text', text: JSON.stringify(payload) }],
			structuredContent: payload,
		})
		const text = JSON.parse(out.content[0]?.text ?? '')
		expect(text.rows[0].next_run_copenhagen).toBe('2026-11-17 21:00')
		expect(out.structuredContent.rows[0]).toMatchObject({ next_run_copenhagen: '2026-11-17 21:00' })
	})

	it('leaves plain text and non-JSON blocks as they are', () => {
		const response = { content: [{ type: 'text' as const, text: 'Done at 2026-11-17T20:00:00Z.' }] }
		expect(addCopenhagenTimesToResponse(response)).toEqual(response)
	})

	it('keeps symbol-keyed extras the server reads from a handler response', () => {
		const tag = Symbol('view')
		const out = addCopenhagenTimesToResponse({ content: [], [tag]: 'kept' })
		expect((out as unknown as Record<symbol, unknown>)[tag]).toBe('kept')
	})
})
