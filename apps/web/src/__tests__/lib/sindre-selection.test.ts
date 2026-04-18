import { EMPTY_SINDRE_SELECTION, buildOneShotActionPrompt } from '@/lib/sindre-selection'
import { describe, expect, it } from 'vitest'

describe('buildOneShotActionPrompt', () => {
	it('returns the raw content when there are no attached objects', () => {
		expect(buildOneShotActionPrompt('hello', [])).toBe('hello')
	})

	it('appends a context block with title + type for each attached object', () => {
		const prompt = buildOneShotActionPrompt('please review', [
			{ id: 'obj-1', title: 'Ship auth rewrite', type: 'bet' },
			{ id: 'obj-2', title: 'Wire send action', type: 'task' },
		])

		expect(prompt).toBe(
			[
				'please review',
				'',
				'---',
				'Context objects:',
				'- Ship auth rewrite (bet) — id: obj-1',
				'- Wire send action (task) — id: obj-2',
			].join('\n'),
		)
	})

	it('falls back to the id when title is missing or blank, and omits type when absent', () => {
		const prompt = buildOneShotActionPrompt('hi', [
			{ id: 'obj-1', title: null },
			{ id: 'obj-2', title: '   ' },
		])

		expect(prompt).toBe(
			['hi', '', '---', 'Context objects:', '- obj-1 — id: obj-1', '- obj-2 — id: obj-2'].join(
				'\n',
			),
		)
	})

	it('exports an empty selection constant with no agent and no objects', () => {
		expect(EMPTY_SINDRE_SELECTION).toEqual({ agent: null, objects: [] })
	})
})
