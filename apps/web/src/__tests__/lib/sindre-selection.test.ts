import {
	EMPTY_SINDRE_SELECTION,
	type SindreSelection,
	buildOneShotActionPrompt,
	sindreSelectionReducer,
} from '@/lib/sindre-selection'
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

	it('appends a notification context block when notifications are attached', () => {
		const prompt = buildOneShotActionPrompt(
			'what is this?',
			[],
			[
				{ id: 'notif-1', title: 'Build failed' },
				{ id: 'notif-2', title: null },
			],
		)

		expect(prompt).toBe(
			[
				'what is this?',
				'',
				'---',
				'Context notifications:',
				'- Build failed — id: notif-1',
				'- notif-2 — id: notif-2',
			].join('\n'),
		)
	})

	it('combines object and notification context blocks in a single block', () => {
		const prompt = buildOneShotActionPrompt(
			'help',
			[{ id: 'obj-1', title: 'Bet Alpha', type: 'bet' }],
			[{ id: 'notif-1', title: 'PR merged' }],
		)

		expect(prompt).toBe(
			[
				'help',
				'',
				'---',
				'Context objects:',
				'- Bet Alpha (bet) — id: obj-1',
				'',
				'Context notifications:',
				'- PR merged — id: notif-1',
			].join('\n'),
		)
	})

	it('exports an empty selection constant with no agent, objects, or notifications', () => {
		expect(EMPTY_SINDRE_SELECTION).toEqual({ agent: null, objects: [], notifications: [] })
	})
})

describe('sindreSelectionReducer', () => {
	const agentA = { id: 'actor-a', name: 'Agent A' }
	const agentB = { id: 'actor-b', name: 'Agent B' }
	const obj1 = { id: 'obj-1', title: 'One', type: 'bet' }
	const obj2 = { id: 'obj-2', title: 'Two', type: 'task' }
	const notif1 = { id: 'notif-1', title: 'Build failed' }
	const notif2 = { id: 'notif-2', title: 'PR merged' }

	describe('add_agent', () => {
		it('sets the agent when the selection is empty', () => {
			const next = sindreSelectionReducer(EMPTY_SINDRE_SELECTION, {
				type: 'add_agent',
				agent: agentA,
			})
			expect(next.agent).toEqual(agentA)
			expect(next.objects).toEqual([])
		})

		it('replaces the existing agent (single-agent rule)', () => {
			const state: SindreSelection = { agent: agentA, objects: [], notifications: [] }
			const next = sindreSelectionReducer(state, { type: 'add_agent', agent: agentB })
			expect(next.agent).toEqual(agentB)
		})

		it('does not touch selected objects when the agent changes', () => {
			const state: SindreSelection = { agent: agentA, objects: [obj1, obj2], notifications: [] }
			const next = sindreSelectionReducer(state, { type: 'add_agent', agent: agentB })
			expect(next.agent).toEqual(agentB)
			expect(next.objects).toEqual([obj1, obj2])
			// objects array reference is preserved — we only spread the top-level state.
			expect(next.objects).toBe(state.objects)
		})

		it('returns the same state reference when the agent is unchanged', () => {
			const state: SindreSelection = { agent: agentA, objects: [obj1], notifications: [] }
			const next = sindreSelectionReducer(state, {
				type: 'add_agent',
				agent: { ...agentA },
			})
			expect(next).toBe(state)
		})

		it('treats differing name fields as a change even when the id matches', () => {
			const state: SindreSelection = { agent: agentA, objects: [], notifications: [] }
			const renamed = { id: agentA.id, name: 'Agent A (renamed)' }
			const next = sindreSelectionReducer(state, { type: 'add_agent', agent: renamed })
			expect(next).not.toBe(state)
			expect(next.agent).toEqual(renamed)
		})
	})

	describe('remove_agent', () => {
		it('clears the agent when one is set', () => {
			const state: SindreSelection = { agent: agentA, objects: [obj1], notifications: [] }
			const next = sindreSelectionReducer(state, { type: 'remove_agent' })
			expect(next.agent).toBeNull()
			expect(next.objects).toEqual([obj1])
		})

		it('returns the same state reference when the agent is already null', () => {
			const state: SindreSelection = { agent: null, objects: [obj1], notifications: [] }
			const next = sindreSelectionReducer(state, { type: 'remove_agent' })
			expect(next).toBe(state)
		})
	})

	describe('add_object', () => {
		it('appends a new object in insertion order', () => {
			const state: SindreSelection = { agent: null, objects: [obj1], notifications: [] }
			const next = sindreSelectionReducer(state, { type: 'add_object', object: obj2 })
			expect(next.objects).toEqual([obj1, obj2])
		})

		it('deduplicates by id — re-adding an existing id is a no-op', () => {
			const state: SindreSelection = { agent: null, objects: [obj1], notifications: [] }
			const duplicate = { ...obj1, title: 'different title' }
			const next = sindreSelectionReducer(state, { type: 'add_object', object: duplicate })
			expect(next).toBe(state)
			expect(next.objects).toEqual([obj1])
		})

		it('does not touch the agent when an object is added', () => {
			const state: SindreSelection = { agent: agentA, objects: [], notifications: [] }
			const next = sindreSelectionReducer(state, { type: 'add_object', object: obj1 })
			expect(next.agent).toEqual(agentA)
			expect(next.objects).toEqual([obj1])
		})
	})

	describe('remove_object', () => {
		it('removes the object with the given id', () => {
			const state: SindreSelection = { agent: null, objects: [obj1, obj2], notifications: [] }
			const next = sindreSelectionReducer(state, { type: 'remove_object', id: obj1.id })
			expect(next.objects).toEqual([obj2])
		})

		it('returns the same state reference when the id is not in the selection', () => {
			const state: SindreSelection = { agent: null, objects: [obj1], notifications: [] }
			const next = sindreSelectionReducer(state, { type: 'remove_object', id: 'missing' })
			expect(next).toBe(state)
		})

		it('does not touch the agent when an object is removed', () => {
			const state: SindreSelection = { agent: agentA, objects: [obj1], notifications: [] }
			const next = sindreSelectionReducer(state, { type: 'remove_object', id: obj1.id })
			expect(next.agent).toEqual(agentA)
			expect(next.objects).toEqual([])
		})
	})

	describe('add_notification', () => {
		it('appends a new notification in insertion order', () => {
			const state: SindreSelection = { agent: null, objects: [], notifications: [notif1] }
			const next = sindreSelectionReducer(state, {
				type: 'add_notification',
				notification: notif2,
			})
			expect(next.notifications).toEqual([notif1, notif2])
		})

		it('deduplicates by id — re-adding an existing id is a no-op', () => {
			const state: SindreSelection = { agent: null, objects: [], notifications: [notif1] }
			const duplicate = { ...notif1, title: 'different title' }
			const next = sindreSelectionReducer(state, {
				type: 'add_notification',
				notification: duplicate,
			})
			expect(next).toBe(state)
			expect(next.notifications).toEqual([notif1])
		})

		it('does not touch the agent or objects when a notification is added', () => {
			const state: SindreSelection = { agent: agentA, objects: [obj1], notifications: [] }
			const next = sindreSelectionReducer(state, {
				type: 'add_notification',
				notification: notif1,
			})
			expect(next.agent).toEqual(agentA)
			expect(next.objects).toEqual([obj1])
			expect(next.notifications).toEqual([notif1])
		})
	})

	describe('remove_notification', () => {
		it('removes the notification with the given id', () => {
			const state: SindreSelection = {
				agent: null,
				objects: [],
				notifications: [notif1, notif2],
			}
			const next = sindreSelectionReducer(state, {
				type: 'remove_notification',
				id: notif1.id,
			})
			expect(next.notifications).toEqual([notif2])
		})

		it('returns the same state reference when the id is not in the selection', () => {
			const state: SindreSelection = { agent: null, objects: [], notifications: [notif1] }
			const next = sindreSelectionReducer(state, {
				type: 'remove_notification',
				id: 'missing',
			})
			expect(next).toBe(state)
		})
	})

	describe('clear_all', () => {
		it('resets a populated selection back to empty', () => {
			const state: SindreSelection = {
				agent: agentA,
				objects: [obj1, obj2],
				notifications: [notif1],
			}
			const next = sindreSelectionReducer(state, { type: 'clear_all' })
			expect(next).toEqual(EMPTY_SINDRE_SELECTION)
		})

		it('returns the same state reference when the selection is already empty', () => {
			const next = sindreSelectionReducer(EMPTY_SINDRE_SELECTION, { type: 'clear_all' })
			expect(next).toBe(EMPTY_SINDRE_SELECTION)
		})

		it('clears a selection that only has notifications', () => {
			const state: SindreSelection = { agent: null, objects: [], notifications: [notif1] }
			const next = sindreSelectionReducer(state, { type: 'clear_all' })
			expect(next).toEqual(EMPTY_SINDRE_SELECTION)
		})
	})

	it('is pure — reducing never mutates the input state', () => {
		const state: SindreSelection = { agent: agentA, objects: [obj1], notifications: [notif1] }
		const snapshot = {
			agent: { ...state.agent },
			objects: [...state.objects],
			notifications: [...state.notifications],
		}

		sindreSelectionReducer(state, { type: 'add_agent', agent: agentB })
		sindreSelectionReducer(state, { type: 'remove_agent' })
		sindreSelectionReducer(state, { type: 'add_object', object: obj2 })
		sindreSelectionReducer(state, { type: 'remove_object', id: obj1.id })
		sindreSelectionReducer(state, { type: 'add_notification', notification: notif2 })
		sindreSelectionReducer(state, { type: 'remove_notification', id: notif1.id })
		sindreSelectionReducer(state, { type: 'clear_all' })

		expect(state).toEqual(snapshot)
	})
})
