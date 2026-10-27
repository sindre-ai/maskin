import { buildStatusChips, buildTypeChips, failedTypeKeys } from '@/lib/search/chips'
import { describe, expect, it } from 'vitest'

const options = [
	{ key: 'chat', label: 'Chats' },
	{ key: 'loop', label: 'Loops' },
	{ key: 'company', label: 'Companies' },
]
const fallbackLabel = (key: string) => `[${key}]`

describe('buildTypeChips', () => {
	it('shows every chip with a null count before the first answer', () => {
		const chips = buildTypeChips({ options, counts: null, selected: [], fallbackLabel })
		expect(chips.map((c) => [c.key, c.count])).toEqual([
			['chat', null],
			['loop', null],
			['company', null],
		])
	})

	it('hides a zero-count chip unless it is selected', () => {
		const counts = { chat: 4, loop: 0, company: 0 }
		const hidden = buildTypeChips({ options, counts, selected: [], fallbackLabel })
		expect(hidden.map((c) => c.key)).toEqual(['chat'])

		const kept = buildTypeChips({ options, counts, selected: ['company'], fallbackLabel })
		expect(kept.map((c) => [c.key, c.count, c.selected])).toEqual([
			['chat', 4, false],
			['company', 0, true],
		])
	})

	it('adds a chip for a type the endpoint counts that the workspace list lacks', () => {
		const chips = buildTypeChips({
			options,
			counts: { chat: 1, loop: 1, company: 1, meeting: 2 },
			selected: [],
			fallbackLabel,
		})
		expect(chips.at(-1)).toMatchObject({ key: 'meeting', label: '[meeting]', count: 2 })
	})

	it('keeps a selected type that is in neither list', () => {
		const chips = buildTypeChips({ options, counts: null, selected: ['gone'], fallbackLabel })
		expect(chips.find((c) => c.key === 'gone')).toMatchObject({ selected: true })
	})
})

describe('buildStatusChips', () => {
	it('lists the five groups in order with a dash-ready null count at first', () => {
		const chips = buildStatusChips({ counts: null, selected: [] })
		expect(chips.map((c) => c.label)).toEqual([
			'Needs you',
			'In progress',
			'New',
			'Done',
			'Archived',
		])
		expect(chips.every((c) => c.count === null)).toBe(true)
	})

	it('hides empty groups unless selected', () => {
		const counts = { needs_you: 0, in_progress: 5, new: 0, done: 2, archived: 0 }
		expect(buildStatusChips({ counts, selected: [] }).map((c) => c.key)).toEqual([
			'in_progress',
			'done',
		])
		expect(buildStatusChips({ counts, selected: ['needs_you'] }).map((c) => c.key)).toEqual([
			'needs_you',
			'in_progress',
			'done',
		])
	})
})

describe('failedTypeKeys', () => {
	it('maps a failed fixed source to its own chip', () => {
		expect(failedTypeKeys(['loops', 'automations'], ['chat', 'loop', 'company'])).toEqual([
			'loop',
			'automation',
		])
	})

	it('maps a failed objects source to every chip that is not a fixed source', () => {
		expect(
			failedTypeKeys(['objects'], ['chat', 'loop', 'agent', 'bet', 'company', 'automation']),
		).toEqual(['bet', 'company'])
	})

	it('returns nothing when no source failed', () => {
		expect(failedTypeKeys([], ['chat'])).toEqual([])
	})
})

describe('buildTypeChips with a failed source', () => {
	it('keeps the failed chip with a dash even though its count is zero', () => {
		const counts = { chat: 4, loop: 0, company: 0 }
		const chips = buildTypeChips({
			options,
			counts,
			selected: [],
			fallbackLabel,
			failed: ['loop'],
		})
		expect(chips.map((c) => [c.key, c.count])).toEqual([
			['chat', 4],
			['loop', null],
		])
	})
})
