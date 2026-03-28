import { formatEventDescription, isErrorEvent } from '@/components/activity/format-event'
import { buildEventResponse } from '../../factories'

describe('formatEventDescription', () => {
	it('returns "proposed bet" for created bet', () => {
		const event = buildEventResponse({ action: 'created', entityType: 'bet' })
		expect(formatEventDescription(event)).toBe('proposed bet')
	})

	it('returns "created {type}" for created non-bet', () => {
		const event = buildEventResponse({ action: 'created', entityType: 'insight' })
		expect(formatEventDescription(event)).toBe('created insight')
	})

	it('returns "updated {type}"', () => {
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

	it('formats unknown actions with underscores replaced', () => {
		const event = buildEventResponse({ action: 'status_changed', entityType: 'bet' })
		expect(formatEventDescription(event)).toBe('status changed bet')
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
