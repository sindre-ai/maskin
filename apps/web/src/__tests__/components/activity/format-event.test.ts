import { formatEventDescription, isErrorEvent } from '@/components/activity/format-event'
import type { ActorListItem } from '@/lib/api'
import { buildActorListItem, buildEventResponse } from '../../factories'

function actorsMap(actors: ActorListItem[]): Map<string, ActorListItem> {
	return new Map(actors.map((a) => [a.id, a]))
}

describe('formatEventDescription', () => {
	it('returns "proposed bet" for created bet', () => {
		const event = buildEventResponse({ action: 'created', entityType: 'bet' })
		expect(formatEventDescription(event)).toBe('proposed bet')
	})

	it('returns "created {type}" for created non-bet', () => {
		const event = buildEventResponse({ action: 'created', entityType: 'insight' })
		expect(formatEventDescription(event)).toBe('created insight')
	})

	it('returns "updated {type}" when update event has no data', () => {
		const event = buildEventResponse({ action: 'updated', entityType: 'task' })
		expect(formatEventDescription(event)).toBe('updated task')
	})

	it('returns "deleted {type}"', () => {
		const event = buildEventResponse({ action: 'deleted', entityType: 'bet' })
		expect(formatEventDescription(event)).toBe('deleted bet')
	})

	it('returns "started session"', () => {
		const event = buildEventResponse({ action: 'session_created', entityType: 'session' })
		expect(formatEventDescription(event)).toBe('started session')
	})

	it('returns "is running session"', () => {
		const event = buildEventResponse({ action: 'session_running', entityType: 'session' })
		expect(formatEventDescription(event)).toBe('is running session')
	})

	it('returns "completed session"', () => {
		const event = buildEventResponse({ action: 'session_completed', entityType: 'session' })
		expect(formatEventDescription(event)).toBe('completed session')
	})

	it('returns "session failed"', () => {
		const event = buildEventResponse({ action: 'session_failed', entityType: 'session' })
		expect(formatEventDescription(event)).toBe('session failed')
	})

	it('returns "session timed out"', () => {
		const event = buildEventResponse({ action: 'session_timeout', entityType: 'session' })
		expect(formatEventDescription(event)).toBe('session timed out')
	})

	it('returns "paused session"', () => {
		const event = buildEventResponse({ action: 'session_paused', entityType: 'session' })
		expect(formatEventDescription(event)).toBe('paused session')
	})

	it('returns "fired trigger"', () => {
		const event = buildEventResponse({ action: 'trigger_fired', entityType: 'trigger' })
		expect(formatEventDescription(event)).toBe('fired trigger')
	})

	it('falls back to "updated {type}" when status_changed has no data', () => {
		const event = buildEventResponse({ action: 'status_changed', entityType: 'bet' })
		expect(formatEventDescription(event)).toBe('updated bet')
	})

	describe('object update diff', () => {
		it('formats status change with capitalized labels', () => {
			const event = buildEventResponse({
				action: 'status_changed',
				entityType: 'bet',
				data: {
					previous: { status: 'signal' },
					updated: { status: 'proposed' },
				},
			})

			expect(formatEventDescription(event)).toBe('changed status from Signal to Proposed')
		})

		it('formats multi-word status with title case', () => {
			const event = buildEventResponse({
				action: 'status_changed',
				entityType: 'task',
				data: {
					previous: { status: 'todo' },
					updated: { status: 'in_progress' },
				},
			})

			expect(formatEventDescription(event)).toBe('changed status from Todo to In Progress')
		})

		it('formats content update', () => {
			const event = buildEventResponse({
				action: 'updated',
				entityType: 'bet',
				data: {
					previous: { content: 'old body' },
					updated: { content: 'new body' },
				},
			})

			expect(formatEventDescription(event)).toBe('updated content')
		})

		it('formats title update with from/to quotes', () => {
			const event = buildEventResponse({
				action: 'updated',
				entityType: 'bet',
				data: {
					previous: { title: 'Old Title' },
					updated: { title: 'New Title' },
				},
			})

			expect(formatEventDescription(event)).toBe('changed title from "Old Title" to "New Title"')
		})

		it('formats title set when previous title was empty', () => {
			const event = buildEventResponse({
				action: 'updated',
				entityType: 'bet',
				data: {
					previous: { title: '' },
					updated: { title: 'Fresh Title' },
				},
			})

			expect(formatEventDescription(event)).toBe('set title to "Fresh Title"')
		})

		it('formats owner change using actor name lookup', () => {
			const alice = buildActorListItem({ id: 'actor-alice', name: 'Alice' })
			const bob = buildActorListItem({ id: 'actor-bob', name: 'Bob' })
			const event = buildEventResponse({
				action: 'updated',
				entityType: 'bet',
				data: {
					previous: { owner: 'actor-alice' },
					updated: { owner: 'actor-bob' },
				},
			})

			expect(formatEventDescription(event, { actorsById: actorsMap([alice, bob]) })).toBe(
				'changed owner from Alice to Bob',
			)
		})

		it('formats owner cleared as "no one"', () => {
			const alice = buildActorListItem({ id: 'actor-alice', name: 'Alice' })
			const event = buildEventResponse({
				action: 'updated',
				entityType: 'bet',
				data: {
					previous: { owner: 'actor-alice' },
					updated: { owner: null },
				},
			})

			expect(formatEventDescription(event, { actorsById: actorsMap([alice]) })).toBe(
				'changed owner from Alice to no one',
			)
		})

		it('joins multiple clauses with " and "', () => {
			const event = buildEventResponse({
				action: 'status_changed',
				entityType: 'bet',
				data: {
					previous: { status: 'signal', content: 'old' },
					updated: { status: 'proposed', content: 'new' },
				},
			})

			expect(formatEventDescription(event)).toBe(
				'changed status from Signal to Proposed and updated content',
			)
		})

		it('emits one clause per changed metadata key', () => {
			const event = buildEventResponse({
				action: 'updated',
				entityType: 'bet',
				data: {
					previous: { metadata: { priority: 'low', estimate: 3 } },
					updated: { metadata: { priority: 'high', estimate: 3 } },
				},
			})

			expect(formatEventDescription(event)).toBe('updated custom field: priority')
		})

		it('collapses many metadata changes into a count', () => {
			const event = buildEventResponse({
				action: 'updated',
				entityType: 'bet',
				data: {
					previous: { metadata: { a: 1, b: 2, c: 3, d: 4 } },
					updated: { metadata: { a: 11, b: 22, c: 33, d: 44 } },
				},
			})

			expect(formatEventDescription(event)).toBe('updated 4 custom fields')
		})

		it('falls back to "updated {type}" when no tracked field changed', () => {
			const event = buildEventResponse({
				action: 'updated',
				entityType: 'bet',
				data: {
					previous: { status: 'signal', title: 'same' },
					updated: { status: 'signal', title: 'same' },
				},
			})

			expect(formatEventDescription(event)).toBe('updated bet')
		})
	})
})

describe('isErrorEvent', () => {
	it('returns true for failed actions', () => {
		const event = buildEventResponse({ action: 'session_failed' })
		expect(isErrorEvent(event)).toBe(true)
	})

	it('returns true for timeout actions', () => {
		const event = buildEventResponse({ action: 'session_timeout' })
		expect(isErrorEvent(event)).toBe(true)
	})

	it('returns false for normal actions', () => {
		const event = buildEventResponse({ action: 'created' })
		expect(isErrorEvent(event)).toBe(false)
	})

	it('returns false for completed actions', () => {
		const event = buildEventResponse({ action: 'session_completed' })
		expect(isErrorEvent(event)).toBe(false)
	})
})
