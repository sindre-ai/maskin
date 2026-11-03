import {
	type ChatSelection,
	EMPTY_CHAT_SELECTION,
	buildOneShotActionPrompt,
	chatSelectionReducer,
} from '@/lib/chat-selection'
import { MESSAGE_MAX_MENTIONS } from '@maskin/shared'
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

	it('exports an empty selection constant with no mentions, objects, or notifications', () => {
		expect(EMPTY_CHAT_SELECTION).toEqual({
			agents: [],
			agentNames: {},
			objects: [],
			notifications: [],
			files: [],
		})
	})
})

describe('chatSelectionReducer', () => {
	const agentA = { id: 'actor-a', name: 'Agent A' }
	const agentB = { id: 'actor-b', name: 'Agent B' }
	const obj1 = { id: 'obj-1', title: 'One', type: 'bet' }
	const obj2 = { id: 'obj-2', title: 'Two', type: 'task' }
	const notif1 = { id: 'notif-1', title: 'Build failed' }
	const notif2 = { id: 'notif-2', title: 'PR merged' }

	describe('add_agent', () => {
		it('appends the mention when the list is empty', () => {
			const next = chatSelectionReducer(EMPTY_CHAT_SELECTION, {
				type: 'add_agent',
				agent: agentA,
			})
			expect(next.agents).toEqual([agentA.id])
			expect(next.agentNames).toEqual({ [agentA.id]: agentA.name })
			expect(next.objects).toEqual([])
		})

		it('appends a second mention preserving insertion order (multi-mention rule)', () => {
			const first = chatSelectionReducer(EMPTY_CHAT_SELECTION, {
				type: 'add_agent',
				agent: agentA,
			})
			const second = chatSelectionReducer(first, { type: 'add_agent', agent: agentB })
			expect(second.agents).toEqual([agentA.id, agentB.id])
			expect(second.agentNames).toEqual({
				[agentA.id]: agentA.name,
				[agentB.id]: agentB.name,
			})
		})

		it('does not touch selected objects when a mention is added', () => {
			const state: ChatSelection = {
				agents: [agentA.id],
				agentNames: { [agentA.id]: agentA.name },
				objects: [obj1, obj2],
				notifications: [],
				files: [],
			}
			const next = chatSelectionReducer(state, { type: 'add_agent', agent: agentB })
			expect(next.agents).toEqual([agentA.id, agentB.id])
			expect(next.objects).toEqual([obj1, obj2])
			// objects array reference is preserved — we only spread the top-level state.
			expect(next.objects).toBe(state.objects)
		})

		it('deduplicates by id — re-adding an id that already exists is a no-op (same name)', () => {
			const state: ChatSelection = {
				agents: [agentA.id],
				agentNames: { [agentA.id]: agentA.name },
				objects: [obj1],
				notifications: [],
				files: [],
			}
			const next = chatSelectionReducer(state, {
				type: 'add_agent',
				agent: { ...agentA },
			})
			expect(next).toBe(state)
		})

		it('refreshes the cached name when the picker learns a new label for the same id', () => {
			const state: ChatSelection = {
				agents: [agentA.id],
				agentNames: { [agentA.id]: agentA.name },
				objects: [],
				notifications: [],
				files: [],
			}
			const renamed = { id: agentA.id, name: 'Agent A (renamed)' }
			const next = chatSelectionReducer(state, { type: 'add_agent', agent: renamed })
			expect(next).not.toBe(state)
			expect(next.agents).toEqual([agentA.id])
			expect(next.agentNames[agentA.id]).toBe('Agent A (renamed)')
		})

		it(`caps the mentions list at MESSAGE_MAX_MENTIONS (${MESSAGE_MAX_MENTIONS})`, () => {
			let state: ChatSelection = EMPTY_CHAT_SELECTION
			for (let i = 0; i < MESSAGE_MAX_MENTIONS; i++) {
				state = chatSelectionReducer(state, {
					type: 'add_agent',
					agent: { id: `actor-${i}`, name: `Agent ${i}` },
				})
			}
			expect(state.agents).toHaveLength(MESSAGE_MAX_MENTIONS)

			const overflow = chatSelectionReducer(state, {
				type: 'add_agent',
				agent: { id: 'overflow', name: 'Overflow' },
			})
			expect(overflow).toBe(state)
			expect(overflow.agents).toHaveLength(MESSAGE_MAX_MENTIONS)
		})
	})

	describe('remove_agent', () => {
		it('removes the mention with the given id', () => {
			const state: ChatSelection = {
				agents: [agentA.id, agentB.id],
				agentNames: { [agentA.id]: agentA.name, [agentB.id]: agentB.name },
				objects: [obj1],
				notifications: [],
				files: [],
			}
			const next = chatSelectionReducer(state, { type: 'remove_agent', id: agentA.id })
			expect(next.agents).toEqual([agentB.id])
			expect(next.agentNames).toEqual({ [agentB.id]: agentB.name })
			expect(next.objects).toEqual([obj1])
		})

		it('returns the same state reference when the id is not in the mentions list', () => {
			const state: ChatSelection = {
				agents: [agentA.id],
				agentNames: { [agentA.id]: agentA.name },
				objects: [obj1],
				notifications: [],
				files: [],
			}
			const next = chatSelectionReducer(state, { type: 'remove_agent', id: 'missing' })
			expect(next).toBe(state)
		})
	})

	describe('add_object', () => {
		it('appends a new object in insertion order', () => {
			const state: ChatSelection = {
				agents: [],
				agentNames: {},
				objects: [obj1],
				notifications: [],
				files: [],
			}
			const next = chatSelectionReducer(state, { type: 'add_object', object: obj2 })
			expect(next.objects).toEqual([obj1, obj2])
		})

		it('deduplicates by id — re-adding an existing id is a no-op', () => {
			const state: ChatSelection = {
				agents: [],
				agentNames: {},
				objects: [obj1],
				notifications: [],
				files: [],
			}
			const duplicate = { ...obj1, title: 'different title' }
			const next = chatSelectionReducer(state, { type: 'add_object', object: duplicate })
			expect(next).toBe(state)
			expect(next.objects).toEqual([obj1])
		})

		it('does not touch the mentions when an object is added', () => {
			const state: ChatSelection = {
				agents: [agentA.id],
				agentNames: { [agentA.id]: agentA.name },
				objects: [],
				notifications: [],
				files: [],
			}
			const next = chatSelectionReducer(state, { type: 'add_object', object: obj1 })
			expect(next.agents).toEqual([agentA.id])
			expect(next.objects).toEqual([obj1])
		})
	})

	describe('remove_object', () => {
		it('removes the object with the given id', () => {
			const state: ChatSelection = {
				agents: [],
				agentNames: {},
				objects: [obj1, obj2],
				notifications: [],
				files: [],
			}
			const next = chatSelectionReducer(state, { type: 'remove_object', id: obj1.id })
			expect(next.objects).toEqual([obj2])
		})

		it('returns the same state reference when the id is not in the selection', () => {
			const state: ChatSelection = {
				agents: [],
				agentNames: {},
				objects: [obj1],
				notifications: [],
				files: [],
			}
			const next = chatSelectionReducer(state, { type: 'remove_object', id: 'missing' })
			expect(next).toBe(state)
		})

		it('does not touch the mentions when an object is removed', () => {
			const state: ChatSelection = {
				agents: [agentA.id],
				agentNames: { [agentA.id]: agentA.name },
				objects: [obj1],
				notifications: [],
				files: [],
			}
			const next = chatSelectionReducer(state, { type: 'remove_object', id: obj1.id })
			expect(next.agents).toEqual([agentA.id])
			expect(next.objects).toEqual([])
		})
	})

	describe('add_notification', () => {
		it('appends a new notification in insertion order', () => {
			const state: ChatSelection = {
				agents: [],
				agentNames: {},
				objects: [],
				notifications: [notif1],
				files: [],
			}
			const next = chatSelectionReducer(state, {
				type: 'add_notification',
				notification: notif2,
			})
			expect(next.notifications).toEqual([notif1, notif2])
		})

		it('deduplicates by id — re-adding an existing id is a no-op', () => {
			const state: ChatSelection = {
				agents: [],
				agentNames: {},
				objects: [],
				notifications: [notif1],
				files: [],
			}
			const duplicate = { ...notif1, title: 'different title' }
			const next = chatSelectionReducer(state, {
				type: 'add_notification',
				notification: duplicate,
			})
			expect(next).toBe(state)
			expect(next.notifications).toEqual([notif1])
		})

		it('does not touch the mentions or objects when a notification is added', () => {
			const state: ChatSelection = {
				agents: [agentA.id],
				agentNames: { [agentA.id]: agentA.name },
				objects: [obj1],
				notifications: [],
				files: [],
			}
			const next = chatSelectionReducer(state, {
				type: 'add_notification',
				notification: notif1,
			})
			expect(next.agents).toEqual([agentA.id])
			expect(next.objects).toEqual([obj1])
			expect(next.notifications).toEqual([notif1])
		})
	})

	describe('remove_notification', () => {
		it('removes the notification with the given id', () => {
			const state: ChatSelection = {
				agents: [],
				agentNames: {},
				objects: [],
				notifications: [notif1, notif2],
				files: [],
			}
			const next = chatSelectionReducer(state, {
				type: 'remove_notification',
				id: notif1.id,
			})
			expect(next.notifications).toEqual([notif2])
		})

		it('returns the same state reference when the id is not in the selection', () => {
			const state: ChatSelection = {
				agents: [],
				agentNames: {},
				objects: [],
				notifications: [notif1],
				files: [],
			}
			const next = chatSelectionReducer(state, {
				type: 'remove_notification',
				id: 'missing',
			})
			expect(next).toBe(state)
		})
	})

	describe('clear_all', () => {
		it('resets a populated selection back to empty', () => {
			const state: ChatSelection = {
				agents: [agentA.id, agentB.id],
				agentNames: { [agentA.id]: agentA.name, [agentB.id]: agentB.name },
				objects: [obj1, obj2],
				notifications: [notif1],
				files: [],
			}
			const next = chatSelectionReducer(state, { type: 'clear_all' })
			expect(next).toEqual(EMPTY_CHAT_SELECTION)
		})

		it('returns the same state reference when the selection is already empty', () => {
			const next = chatSelectionReducer(EMPTY_CHAT_SELECTION, { type: 'clear_all' })
			expect(next).toBe(EMPTY_CHAT_SELECTION)
		})

		it('clears a selection that only has notifications', () => {
			const state: ChatSelection = {
				agents: [],
				agentNames: {},
				objects: [],
				notifications: [notif1],
				files: [],
			}
			const next = chatSelectionReducer(state, { type: 'clear_all' })
			expect(next).toEqual(EMPTY_CHAT_SELECTION)
		})
	})

	it('is pure — reducing never mutates the input state', () => {
		const state: ChatSelection = {
			agents: [agentA.id],
			agentNames: { [agentA.id]: agentA.name },
			objects: [obj1],
			notifications: [notif1],
			files: [],
		}
		const snapshot = {
			agents: [...state.agents],
			agentNames: { ...state.agentNames },
			objects: [...state.objects],
			notifications: [...state.notifications],
			files: [...state.files],
		}

		chatSelectionReducer(state, { type: 'add_agent', agent: agentB })
		chatSelectionReducer(state, { type: 'remove_agent', id: agentA.id })
		chatSelectionReducer(state, { type: 'add_object', object: obj2 })
		chatSelectionReducer(state, { type: 'remove_object', id: obj1.id })
		chatSelectionReducer(state, { type: 'add_notification', notification: notif2 })
		chatSelectionReducer(state, { type: 'remove_notification', id: notif1.id })
		chatSelectionReducer(state, { type: 'clear_all' })

		expect(state).toEqual(snapshot)
	})
})
