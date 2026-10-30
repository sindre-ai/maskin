import { sourcesAffectedBy } from '@/lib/loop-view-bridge'
import { notifySSEGap, subscribeToSSE } from '@/lib/sse-invalidation'
import { type DataQuerySpec, dataQuerySpecSchema } from '@maskin/shared'
import { describe, expect, it, vi } from 'vitest'

const spec = (input: Record<string, unknown>): DataQuerySpec => dataQuerySpecSchema.parse(input)
const key = (s: DataQuerySpec) => JSON.stringify(s)

describe('sourcesAffectedBy', () => {
	const tasks = spec({ type: 'task' })
	const insights = spec({ type: 'insight', group_by: 'created_at.day' })
	const loopTasks = spec({ type: 'task', scope: '11111111-1111-4111-8111-111111111111' })
	const sources = new Map([
		['tasks', tasks],
		['insights', insights],
		['loopTasks', loopTasks],
	])

	it('picks only the sources that count the changed object type', () => {
		expect(sourcesAffectedBy({ entity_type: 'insight' }, sources)).toEqual(new Set([key(insights)]))
	})

	it('adds loop-scoped sources when a relationship changes', () => {
		expect(sourcesAffectedBy({ entity_type: 'relationship' }, sources)).toEqual(
			new Set([key(loopTasks)]),
		)
	})

	it('ignores events about things no source reads', () => {
		expect(sourcesAffectedBy({ entity_type: 'session' }, sources).size).toBe(0)
	})

	it('treats a possible gap as affecting every source', () => {
		expect(sourcesAffectedBy(null, sources).size).toBe(3)
	})
})

describe('subscribeToSSE', () => {
	it('tells a listener about a gap until it unsubscribes', () => {
		const listener = vi.fn()
		const unsubscribe = subscribeToSSE(listener)
		notifySSEGap()
		expect(listener).toHaveBeenCalledWith(null)
		unsubscribe()
		notifySSEGap()
		expect(listener).toHaveBeenCalledTimes(1)
	})
})
