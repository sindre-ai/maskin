import type { ObjectResponse } from '@/lib/api'
import { NO_VALUE_GROUP, getObjectGroupLabel, getObjectGroupValue } from '@/lib/objects-grouping'
import { describe, expect, it } from 'vitest'
import { buildActorListItem } from '../factories'

const base = (overrides: Partial<ObjectResponse> = {}): ObjectResponse => ({
	id: 'obj-1',
	workspaceId: 'ws-1',
	type: 'bet',
	title: 'Test',
	content: null,
	status: 'active',
	metadata: null,
	driver: null,
	activeSessionId: null,
	createdBy: 'actor-1',
	createdAt: null,
	updatedAt: null,
	...overrides,
})

describe('getObjectGroupValue', () => {
	it('buckets by status when groupBy is missing or status', () => {
		expect(getObjectGroupValue(base({ status: 'in_progress' }), undefined)).toBe('in_progress')
		expect(getObjectGroupValue(base({ status: 'done' }), 'status')).toBe('done')
	})

	it('maps empty driver to the No value sentinel', () => {
		expect(getObjectGroupValue(base({ driver: null }), 'driver')).toBe(NO_VALUE_GROUP)
		expect(getObjectGroupValue(base({ driver: 'actor-2' }), 'driver')).toBe('actor-2')
	})

	it('reads metadata.<key> groups and maps empty/absent values to the sentinel', () => {
		expect(getObjectGroupValue(base({ metadata: { priority: 'high' } }), 'metadata.priority')).toBe(
			'high',
		)
		expect(getObjectGroupValue(base({ metadata: { priority: '' } }), 'metadata.priority')).toBe(
			NO_VALUE_GROUP,
		)
		expect(getObjectGroupValue(base(), 'metadata.region')).toBe(NO_VALUE_GROUP)
	})
})

describe('getObjectGroupLabel', () => {
	const actors = [
		buildActorListItem({ id: 'actor-1', name: 'Priya', type: 'human' }),
		buildActorListItem({ id: 'actor-2', name: 'Marvin', type: 'agent' }),
	]

	it('de-underscores status values', () => {
		expect(getObjectGroupLabel('status', 'in_progress')).toBe('in progress')
	})

	it('resolves actor-keyed groups to the actor name and falls back to the raw id', () => {
		expect(getObjectGroupLabel('driver', 'actor-1', actors)).toBe('Priya')
		expect(getObjectGroupLabel('owner', 'actor-2', actors)).toBe('Marvin')
		expect(getObjectGroupLabel('createdBy', 'unknown-id', actors)).toBe('unknown-id')
	})

	it('formats date-keyed groups as ordinal day, month, year', () => {
		expect(getObjectGroupLabel('createdAt', '2026-03-02')).toBe('2nd March 2026')
		expect(getObjectGroupLabel('updatedAt', '2026-05-21')).toBe('21st May 2026')
	})

	it('passes non-date, non-status values through unchanged', () => {
		expect(getObjectGroupLabel('metadata.priority', 'high')).toBe('high')
	})
})
