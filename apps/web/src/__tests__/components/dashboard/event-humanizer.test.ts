import {
	type ActorLookup,
	type ObjectLookup,
	humanizeEvents,
} from '@/components/dashboard/event-humanizer'
import type { ActorListItem, ObjectResponse } from '@/lib/api'
import { describe, expect, it } from 'vitest'
import { buildActorListItem, buildEventResponse, buildObjectResponse } from '../../factories'

function lookupFrom<T extends { id: string }>(items: T[]): (id: string | null) => T | undefined {
	const map = new Map<string, T>()
	for (const item of items) map.set(item.id, item)
	return (id) => (id ? map.get(id) : undefined)
}

function makeLookups(
	actors: ActorListItem[],
	objects: ObjectResponse[],
): { actorLookup: ActorLookup; objectLookup: ObjectLookup } {
	return {
		actorLookup: lookupFrom(actors),
		objectLookup: lookupFrom(objects),
	}
}

function partsAsText(parts: ReturnType<typeof humanizeEvents>[number]['parts']): string {
	return parts
		.map((p) => (p.kind === 'text' ? p.text : p.kind === 'object' ? p.title : p.label))
		.join(' ')
}

describe('humanizeEvents — created actions', () => {
	it('renders agent voice for created bet', () => {
		const agent = buildActorListItem({ id: 'a-1', type: 'agent', name: 'Eli' })
		const bet = buildObjectResponse({ id: 'obj-bet', type: 'bet', title: 'Auth tweak' })
		const event = buildEventResponse({
			actorId: 'a-1',
			action: 'created',
			entityType: 'bet',
			entityId: 'obj-bet',
		})

		const { actorLookup, objectLookup } = makeLookups([agent], [bet])
		const [caption] = humanizeEvents([event], actorLookup, objectLookup)

		expect(caption.actorType).toBe('agent')
		expect(caption.actorName).toBe('Eli')
		expect(partsAsText(caption.parts)).toBe('I proposed Auth tweak')
		expect(caption.parts.find((p) => p.kind === 'object')).toMatchObject({
			objectId: 'obj-bet',
			objectType: 'bet',
			title: 'Auth tweak',
		})
	})

	it('renders human voice for created task', () => {
		const human = buildActorListItem({ id: 'a-h', type: 'human', name: 'Ada' })
		const task = buildObjectResponse({ id: 'obj-t', type: 'task', title: 'Write docs' })
		const event = buildEventResponse({
			actorId: 'a-h',
			action: 'created',
			entityType: 'task',
			entityId: 'obj-t',
		})

		const { actorLookup, objectLookup } = makeLookups([human], [task])
		const [caption] = humanizeEvents([event], actorLookup, objectLookup)

		expect(caption.actorType).toBe('human')
		expect(partsAsText(caption.parts)).toBe('created Write docs')
	})

	it('falls back to "a {entityType}" when the object is unknown', () => {
		const agent = buildActorListItem({ id: 'a-1', type: 'agent', name: 'Eli' })
		const event = buildEventResponse({
			actorId: 'a-1',
			action: 'created',
			entityType: 'task',
			entityId: 'missing',
		})

		const { actorLookup, objectLookup } = makeLookups([agent], [])
		const [caption] = humanizeEvents([event], actorLookup, objectLookup)

		expect(partsAsText(caption.parts)).toBe('I created a task')
	})

	it('falls back to "Someone" with third-person voice when actor is unknown', () => {
		const event = buildEventResponse({
			actorId: 'ghost',
			action: 'created',
			entityType: 'task',
			data: { title: 'Phantom task' },
		})

		const { actorLookup, objectLookup } = makeLookups([], [])
		const [caption] = humanizeEvents([event], actorLookup, objectLookup)

		expect(caption.actorName).toBe('Someone')
		expect(caption.actorType).toBe('human')
		expect(partsAsText(caption.parts)).toBe('created Phantom task')
	})

	it('reads object title from event.data.title when objectLookup misses', () => {
		const agent = buildActorListItem({ id: 'a-1', type: 'agent', name: 'Eli' })
		const event = buildEventResponse({
			actorId: 'a-1',
			action: 'created',
			entityType: 'task',
			entityId: 'orphan',
			data: { title: 'Inline title' },
		})

		const { actorLookup, objectLookup } = makeLookups([agent], [])
		const [caption] = humanizeEvents([event], actorLookup, objectLookup)

		expect(partsAsText(caption.parts)).toBe('I created Inline title')
	})
})

describe('humanizeEvents — status_changed actions', () => {
	it('agent shipping a task uses "I shipped" with status badge', () => {
		const agent = buildActorListItem({ id: 'a-1', type: 'agent', name: 'Eli' })
		const task = buildObjectResponse({ id: 'obj-t', type: 'task', title: 'Onboarding' })
		const event = buildEventResponse({
			actorId: 'a-1',
			action: 'status_changed',
			entityType: 'task',
			entityId: 'obj-t',
			data: {
				previous: { status: 'in_progress' },
				updated: { status: 'done', title: 'Onboarding' },
			},
		})

		const { actorLookup, objectLookup } = makeLookups([agent], [task])
		const [caption] = humanizeEvents([event], actorLookup, objectLookup)

		expect(partsAsText(caption.parts)).toBe('I shipped Onboarding done')
		const badge = caption.parts.find((p) => p.kind === 'badge')
		expect(badge).toMatchObject({ label: 'done', tone: 'status' })
	})

	it('agent picking up a task uses "I\'m working on"', () => {
		const agent = buildActorListItem({ id: 'a-1', type: 'agent', name: 'Eli' })
		const task = buildObjectResponse({ id: 'obj-t', type: 'task', title: 'Migrate db' })
		const event = buildEventResponse({
			actorId: 'a-1',
			action: 'status_changed',
			entityType: 'task',
			entityId: 'obj-t',
			data: {
				previous: { status: 'todo' },
				updated: { status: 'in_progress', title: 'Migrate db' },
			},
		})

		const { actorLookup, objectLookup } = makeLookups([agent], [task])
		const [caption] = humanizeEvents([event], actorLookup, objectLookup)

		expect(partsAsText(caption.parts)).toContain("I'm working on Migrate db")
	})

	it('human transitions strip the leading first-person pronoun', () => {
		const human = buildActorListItem({ id: 'a-h', type: 'human', name: 'Ada' })
		const task = buildObjectResponse({ id: 'obj-t', type: 'task', title: 'Migrate db' })
		const event = buildEventResponse({
			actorId: 'a-h',
			action: 'status_changed',
			entityType: 'task',
			entityId: 'obj-t',
			data: {
				previous: { status: 'todo' },
				updated: { status: 'in_progress', title: 'Migrate db' },
			},
		})

		const { actorLookup, objectLookup } = makeLookups([human], [task])
		const [caption] = humanizeEvents([event], actorLookup, objectLookup)

		expect(partsAsText(caption.parts).startsWith('working on')).toBe(true)
	})

	it('falls back to a generic "I moved …" for unmapped statuses', () => {
		const agent = buildActorListItem({ id: 'a-1', type: 'agent', name: 'Eli' })
		const task = buildObjectResponse({ id: 'obj-t', type: 'task', title: 'X' })
		const event = buildEventResponse({
			actorId: 'a-1',
			action: 'status_changed',
			entityType: 'task',
			entityId: 'obj-t',
			data: {
				previous: { status: 'a' },
				updated: { status: 'archived', title: 'X' },
			},
		})

		const { actorLookup, objectLookup } = makeLookups([agent], [task])
		const [caption] = humanizeEvents([event], actorLookup, objectLookup)

		expect(partsAsText(caption.parts)).toContain('I moved X to archived')
	})
})

describe('humanizeEvents — session events', () => {
	it.each([
		['session_created', 'I started a new session'],
		['session_running', "I'm running"],
		['session_completed', 'I finished my session'],
		['session_failed', 'My session failed'],
		['session_timeout', 'My session timed out'],
		['session_paused', 'I paused my session'],
		['trigger_fired', 'I fired a trigger'],
	])('agent %s renders as "%s"', (action, expected) => {
		const agent = buildActorListItem({ id: 'a-1', type: 'agent', name: 'Eli' })
		const event = buildEventResponse({
			actorId: 'a-1',
			action,
			entityType: 'session',
			entityId: 'sess-1',
		})

		const { actorLookup, objectLookup } = makeLookups([agent], [])
		const [caption] = humanizeEvents([event], actorLookup, objectLookup)

		expect(partsAsText(caption.parts)).toBe(expected)
	})

	it('marks failed and timeout events as errors', () => {
		const agent = buildActorListItem({ id: 'a-1', type: 'agent' })
		const failed = buildEventResponse({
			id: 1,
			actorId: 'a-1',
			action: 'session_failed',
			entityType: 'session',
		})
		const timeout = buildEventResponse({
			id: 2,
			actorId: 'a-1',
			action: 'session_timeout',
			entityType: 'session',
		})
		const completed = buildEventResponse({
			id: 3,
			actorId: 'a-1',
			action: 'session_completed',
			entityType: 'session',
		})

		const { actorLookup, objectLookup } = makeLookups([agent], [])
		const captions = humanizeEvents([failed, timeout, completed], actorLookup, objectLookup)

		expect(captions[0].isError).toBe(true)
		expect(captions[1].isError).toBe(true)
		expect(captions[2].isError).toBe(false)
	})
})

describe('humanizeEvents — collapse adjacent micro-actions', () => {
	it('collapses adjacent "created task" events from the same agent', () => {
		const agent = buildActorListItem({ id: 'a-1', type: 'agent', name: 'Eli' })
		const events = [
			buildEventResponse({ id: 1, actorId: 'a-1', action: 'created', entityType: 'task' }),
			buildEventResponse({ id: 2, actorId: 'a-1', action: 'created', entityType: 'task' }),
			buildEventResponse({ id: 3, actorId: 'a-1', action: 'created', entityType: 'task' }),
		]

		const { actorLookup, objectLookup } = makeLookups([agent], [])
		const captions = humanizeEvents(events, actorLookup, objectLookup)

		expect(captions).toHaveLength(1)
		expect(captions[0].groupedCount).toBe(3)
		expect(partsAsText(captions[0].parts)).toBe('I created 3 tasks')
	})

	it('does not collapse across different actors', () => {
		const eli = buildActorListItem({ id: 'a-1', type: 'agent', name: 'Eli' })
		const ada = buildActorListItem({ id: 'a-2', type: 'agent', name: 'Ada' })
		const events = [
			buildEventResponse({ id: 1, actorId: 'a-1', action: 'created', entityType: 'task' }),
			buildEventResponse({ id: 2, actorId: 'a-2', action: 'created', entityType: 'task' }),
		]

		const { actorLookup, objectLookup } = makeLookups([eli, ada], [])
		const captions = humanizeEvents(events, actorLookup, objectLookup)

		expect(captions).toHaveLength(2)
		expect(captions[0].actorName).toBe('Eli')
		expect(captions[1].actorName).toBe('Ada')
	})

	it('does not collapse across different actions', () => {
		const agent = buildActorListItem({ id: 'a-1', type: 'agent', name: 'Eli' })
		const events = [
			buildEventResponse({ id: 1, actorId: 'a-1', action: 'created', entityType: 'task' }),
			buildEventResponse({ id: 2, actorId: 'a-1', action: 'updated', entityType: 'task' }),
		]

		const { actorLookup, objectLookup } = makeLookups([agent], [])
		const captions = humanizeEvents(events, actorLookup, objectLookup)

		expect(captions).toHaveLength(2)
	})

	it('only collapses status_changed when the destination status matches', () => {
		const agent = buildActorListItem({ id: 'a-1', type: 'agent', name: 'Eli' })
		const events = [
			buildEventResponse({
				id: 1,
				actorId: 'a-1',
				action: 'status_changed',
				entityType: 'task',
				data: { previous: { status: 'in_progress' }, updated: { status: 'done', title: 'A' } },
			}),
			buildEventResponse({
				id: 2,
				actorId: 'a-1',
				action: 'status_changed',
				entityType: 'task',
				data: { previous: { status: 'in_progress' }, updated: { status: 'done', title: 'B' } },
			}),
			buildEventResponse({
				id: 3,
				actorId: 'a-1',
				action: 'status_changed',
				entityType: 'task',
				data: { previous: { status: 'todo' }, updated: { status: 'in_progress', title: 'C' } },
			}),
		]

		const { actorLookup, objectLookup } = makeLookups([agent], [])
		const captions = humanizeEvents(events, actorLookup, objectLookup)

		expect(captions).toHaveLength(2)
		expect(captions[0].groupedCount).toBe(2)
		expect(partsAsText(captions[0].parts)).toBe('I shipped 2 tasks done')
		expect(captions[1].groupedCount).toBe(1)
	})
})

describe('humanizeEvents — updated and deleted actions', () => {
	it('agent updated action', () => {
		const agent = buildActorListItem({ id: 'a-1', type: 'agent', name: 'Eli' })
		const task = buildObjectResponse({ id: 'obj-t', type: 'task', title: 'X' })
		const event = buildEventResponse({
			actorId: 'a-1',
			action: 'updated',
			entityType: 'task',
			entityId: 'obj-t',
		})

		const { actorLookup, objectLookup } = makeLookups([agent], [task])
		const [caption] = humanizeEvents([event], actorLookup, objectLookup)

		expect(partsAsText(caption.parts)).toBe('I updated X')
	})

	it('human deleted action', () => {
		const human = buildActorListItem({ id: 'a-h', type: 'human', name: 'Ada' })
		const task = buildObjectResponse({ id: 'obj-t', type: 'task', title: 'X' })
		const event = buildEventResponse({
			actorId: 'a-h',
			action: 'deleted',
			entityType: 'task',
			entityId: 'obj-t',
		})

		const { actorLookup, objectLookup } = makeLookups([human], [task])
		const [caption] = humanizeEvents([event], actorLookup, objectLookup)

		expect(partsAsText(caption.parts)).toBe('removed X')
	})
})

describe('humanizeEvents — non-object entities', () => {
	it('renders a session event without trying to link the session as an object', () => {
		const agent = buildActorListItem({ id: 'a-1', type: 'agent', name: 'Eli' })
		const event = buildEventResponse({
			actorId: 'a-1',
			action: 'session_completed',
			entityType: 'session',
			entityId: 'sess-1',
		})

		const { actorLookup, objectLookup } = makeLookups([agent], [])
		const [caption] = humanizeEvents([event], actorLookup, objectLookup)

		expect(caption.parts.some((p) => p.kind === 'object')).toBe(false)
	})
})
