import { rowSub, rowTitle } from '@/lib/search/row-display'
import { describe, expect, it } from 'vitest'

describe('rowTitle', () => {
	it('reads Untitled for an empty or blank title', () => {
		expect(rowTitle({ title: '' })).toBe('Untitled')
		expect(rowTitle({ title: '   ' })).toBe('Untitled')
	})

	it('keeps a real title as it is', () => {
		expect(rowTitle({ title: 'Hans on pricing' })).toBe('Hans on pricing')
	})
})

describe('rowSub', () => {
	it('turns an automation trigger type into plain words', () => {
		expect(rowSub({ group: 'automations', sub: 'cron' })).toBe('Schedule')
		expect(rowSub({ group: 'automations', sub: 'event' })).toBe('Event')
		expect(rowSub({ group: 'automations', sub: 'reminder' })).toBe('Reminder')
	})

	it('shows an unknown trigger type as it came rather than hiding it', () => {
		expect(rowSub({ group: 'automations', sub: 'webhook' })).toBe('webhook')
	})

	it('leaves the sub line of other groups alone, and returns nothing without one', () => {
		expect(rowSub({ group: 'chats', sub: 'Hans, Magnus' })).toBe('Hans, Magnus')
		expect(rowSub({ group: 'objects', sub: null })).toBeUndefined()
	})
})
