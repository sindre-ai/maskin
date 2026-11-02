import { describe, expect, it } from 'vitest'
import { buildRunGoalBlock, extractFinishLine } from '../../services/run-goal'
import { createTestContext } from '../setup'

const WS = '11111111-1111-1111-1111-111111111111'
const FRONTEND = 'https://maskin.io/'

describe('extractFinishLine', () => {
	it('reads a task Done when heading up to the next heading', () => {
		const body =
			'## What to do\n\nBuild it.\n\n## Done when\n\n- It works\n- It is fast\n\n## Not in this task\n\nOther.'
		expect(extractFinishLine('task', body, null)).toBe('- It works\n- It is fast')
	})

	it('reads an acceptance heading and ignores trailing qualifiers in the heading', () => {
		const body = '### Acceptance criteria (end-states)\n\n- X is present'
		expect(extractFinishLine('task', body, null)).toBe('- X is present')
	})

	it('reads a bet success section named How we know it worked', () => {
		const body =
			'## The problem\n\nBad.\n\n## How we know it worked\n\nWon: it moves.\nLost: it does not.'
		expect(extractFinishLine('bet', body, null)).toBe('Won: it moves.\nLost: it does not.')
	})

	it('reads a bold-only label and stops at the next bold-only label', () => {
		const body = '**Done when**\n- one\n- two\n**Notes**\n- unrelated'
		expect(extractFinishLine('task', body, null)).toBe('- one\n- two')
	})

	it('reads a plain line that starts with a finish-line name, just that paragraph', () => {
		const body =
			'Fix the typo.\n\nDone when: the page says Contact.\nAnd the link works.\n\nTarget: /contact'
		expect(extractFinishLine('task', body, null)).toBe(
			'Done when: the page says Contact.\nAnd the link works.',
		)
	})

	it('returns null when nothing is written, and never invents one', () => {
		expect(extractFinishLine('task', '## What to do\n\nJust do it.', null)).toBeNull()
		expect(extractFinishLine('insight', null, null)).toBeNull()
	})

	it('skips a finish-line heading with nothing under it', () => {
		expect(extractFinishLine('task', '## Done when\n\n## Other\n\nText', null)).toBeNull()
	})

	it('uses a loop close condition from metadata, not the body', () => {
		expect(
			extractFinishLine('loop', '## Done when\n\nignored', {
				close_condition: 'A bet is decided.',
			}),
		).toBe('A bet is decided.')
		expect(extractFinishLine('loop', 'body', { close_condition: '  ' })).toBeNull()
	})

	it('caps a long finish line and points back to the object', () => {
		const out = extractFinishLine('task', `## Done when\n\n${'a'.repeat(3000)}`, null) ?? ''
		expect(out.length).toBeLessThan(1300)
		expect(out).toContain('the rest is on the object')
	})
})

describe('buildRunGoalBlock', () => {
	const taskId = '22222222-2222-2222-2222-222222222222'
	const loopId = '33333333-3333-3333-3333-333333333333'
	const triggerId = '44444444-4444-4444-4444-444444444444'

	it('quotes the finish line of the object that woke the run, with its link', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [
			[
				{
					id: taskId,
					type: 'task',
					title: 'Ship it',
					content: '## Done when\n\n- Shipped',
					metadata: null,
				},
			],
			[], // loops by trigger id
			[], // loops by in_loop edge
		]
		const block = await buildRunGoalBlock(
			db,
			{ workspaceId: WS, triggerId, initiatedFromObjectId: taskId },
			FRONTEND,
		)
		expect(block).toContain('## Your goal this run')
		expect(block).toContain(`[Ship it](https://maskin.io/${WS}/objects/${taskId})`)
		expect(block).toContain('> - Shipped')
		expect(block).toContain('Goal: <your goal>')
		expect(block).not.toContain('What this serves')
		expect(block.endsWith('---\n\n')).toBe(true)
	})

	it('says plainly when the woken object has no finish line, with the status as one reading', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [
			[{ id: taskId, type: 'insight', title: 'Odd thing', content: 'Hm.', metadata: null }],
			[],
			[],
		]
		const block = await buildRunGoalBlock(
			db,
			{ workspaceId: WS, triggerId: null, initiatedFromObjectId: taskId },
			FRONTEND,
		)
		expect(block).toContain('No finish line is written on it')
		expect(block).toContain('One reading, if it fits: move the object to its next status.')
	})

	it('treats the trigger prompt as the goal for a run with no object, and links its loop once', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [[{ id: loopId, title: 'Product Delivery' }]]
		const block = await buildRunGoalBlock(
			db,
			{ workspaceId: WS, triggerId, initiatedFromObjectId: null },
			FRONTEND,
		)
		expect(block).toContain('The instruction that follows this block is your goal, as written.')
		expect(block).toContain(
			`What this serves: [Product Delivery](https://maskin.io/${WS}/objects/${loopId})`,
		)
	})

	it('gives a trigger that is in no loop no serves line', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [[]]
		const block = await buildRunGoalBlock(
			db,
			{ workspaceId: WS, triggerId, initiatedFromObjectId: null },
			FRONTEND,
		)
		expect(block).not.toContain('What this serves')
	})

	it('uses the close condition when a loop itself woke the run, and does not list the loop as what it serves', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [
			[
				{
					id: loopId,
					type: 'loop',
					title: 'Product Delivery',
					content: null,
					metadata: { close_condition: 'A bet is decided.' },
				},
			],
			[{ id: loopId, title: 'Product Delivery' }], // its own trigger is in its own list
		]
		const block = await buildRunGoalBlock(
			db,
			{ workspaceId: WS, triggerId, initiatedFromObjectId: loopId },
			FRONTEND,
		)
		expect(block).toContain('its close condition')
		expect(block).toContain('> A bet is decided.')
		expect(block).not.toContain('What this serves')
	})

	it('shows at most two loops and each once', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [
			[{ id: taskId, type: 'task', title: 'T', content: null, metadata: null }],
			[
				{ id: loopId, title: 'A' },
				{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', title: 'B' },
			],
			[{ id: loopId, title: 'A' }],
		]
		const block = await buildRunGoalBlock(
			db,
			{ workspaceId: WS, triggerId, initiatedFromObjectId: taskId },
			FRONTEND,
		)
		const line = block.split('\n').find((l) => l.startsWith('What this serves')) ?? ''
		expect(line.match(/\]\(/g)).toHaveLength(2)
	})
})
