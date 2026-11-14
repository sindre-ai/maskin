import { useObjectOpenedEvent } from '@/hooks/use-object-opened-event'
import type { RelationshipResponse } from '@/lib/api'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	trackObjectOpened: vi.fn(),
	trackLoopResultOpened: vi.fn(),
	trackFirstResultOpened: vi.fn(),
}))

vi.mock('@/lib/analytics', () => ({
	trackObjectOpened: mocks.trackObjectOpened,
	trackLoopResultOpened: mocks.trackLoopResultOpened,
	trackFirstResultOpened: mocks.trackFirstResultOpened,
}))

const object = { id: 'o-1', type: 'insight', createdBy: 'agent-1' }
const actors = [
	{ id: 'agent-1', type: 'agent' },
	{ id: 'human-1', type: 'human' },
] as never

function edge(over: Partial<RelationshipResponse>): RelationshipResponse {
	return {
		id: 'r',
		sourceType: 'object',
		sourceId: 'x',
		targetType: 'object',
		targetId: 'o-1',
		type: 'relates_to',
		createdAt: '2026-11-01T00:00:00.000Z',
		...over,
	} as RelationshipResponse
}

const producedBy = edge({ type: 'produced_by', sourceType: 'session', sourceId: 's-1' })
const inLoop = edge({ type: 'in_loop', sourceId: 'l-1' })

describe('useObjectOpenedEvent', () => {
	beforeEach(() => vi.clearAllMocks())

	it('waits for the graph and the actor list', () => {
		const { rerender } = renderHook((p) => useObjectOpenedEvent(object, p.rels, p.actors), {
			initialProps: { rels: undefined as RelationshipResponse[] | undefined, actors: undefined },
		})
		expect(mocks.trackObjectOpened).not.toHaveBeenCalled()

		rerender({ rels: [producedBy], actors: undefined })
		expect(mocks.trackObjectOpened).not.toHaveBeenCalled()
	})

	it('sends the source run and the maker type once, not on every re-render', () => {
		const { rerender } = renderHook((p) => useObjectOpenedEvent(object, p.rels, actors), {
			initialProps: { rels: [producedBy] },
		})
		rerender({ rels: [producedBy, edge({ sourceId: 'y' })] })
		rerender({ rels: [producedBy] })

		expect(mocks.trackObjectOpened).toHaveBeenCalledTimes(1)
		expect(mocks.trackObjectOpened).toHaveBeenCalledWith({
			entity_id: 'o-1',
			object_subtype: 'insight',
			source_session_id: 's-1',
			created_by_actor_type: 'agent',
		})
		expect(mocks.trackLoopResultOpened).not.toHaveBeenCalled()
	})

	it('sends loop_result_opened with the run when an agent made an item in a flow', () => {
		renderHook(() => useObjectOpenedEvent(object, [producedBy, inLoop], actors))

		expect(mocks.trackFirstResultOpened).toHaveBeenCalledTimes(1)
		expect(mocks.trackLoopResultOpened).toHaveBeenCalledTimes(1)
		expect(mocks.trackLoopResultOpened).toHaveBeenCalledWith({
			entity_id: 'o-1',
			loop_id: 'l-1',
			object_subtype: 'insight',
			source_session_id: 's-1',
			created_by_actor_type: 'agent',
		})
	})

	it('treats a person-made item in a flow as an open, not a result', () => {
		renderHook(() => useObjectOpenedEvent({ ...object, createdBy: 'human-1' }, [inLoop], actors))

		expect(mocks.trackObjectOpened).toHaveBeenCalledWith({
			entity_id: 'o-1',
			object_subtype: 'insight',
			source_session_id: null,
			created_by_actor_type: 'human',
		})
		expect(mocks.trackLoopResultOpened).not.toHaveBeenCalled()
		expect(mocks.trackFirstResultOpened).not.toHaveBeenCalled()
	})

	it('falls back to unknown when the maker is not in the actor list', () => {
		renderHook(() => useObjectOpenedEvent({ ...object, createdBy: 'gone' }, [], actors))

		expect(mocks.trackObjectOpened).toHaveBeenCalledWith(
			expect.objectContaining({ created_by_actor_type: 'unknown' }),
		)
	})

	it('fires again for another item', () => {
		const { rerender } = renderHook((o) => useObjectOpenedEvent(o, [], actors), {
			initialProps: object,
		})
		rerender({ ...object, id: 'o-2' })

		expect(mocks.trackObjectOpened).toHaveBeenCalledTimes(2)
		expect(mocks.trackObjectOpened).toHaveBeenLastCalledWith(
			expect.objectContaining({ entity_id: 'o-2' }),
		)
	})
})
