import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	WORKSPACE_KNOWLEDGE_REFERENCED,
	trackWorkspaceKnowledgeReferenced,
} from '../../../lib/analytics/knowledge-events'

interface InsertCall {
	values: Record<string, unknown>
}

function makeDb(insertBehaviour: 'ok' | 'throw' = 'ok') {
	const calls: InsertCall[] = []
	const insert = vi.fn().mockImplementation(() => ({
		values: (row: Record<string, unknown>) => {
			calls.push({ values: row })
			if (insertBehaviour === 'throw') {
				return Promise.reject(new Error('db down'))
			}
			return Promise.resolve()
		},
	}))
	return {
		db: { insert } as unknown as Parameters<typeof trackWorkspaceKnowledgeReferenced>[0],
		calls,
	}
}

beforeEach(() => {
	capturePosthogEventMock.mockClear()
	capturePosthogEventMock.mockResolvedValue(undefined)
})

describe('trackWorkspaceKnowledgeReferenced', () => {
	it('inserts the ADR-specified events row (action, entity type, payload shape)', async () => {
		const { db, calls } = makeDb()

		await trackWorkspaceKnowledgeReferenced(db, {
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			entityId: 'knowledge-1',
			consumerContextId: 'bet-1',
			sourceTopics: ['topic:company_profile', 'topic:market'],
		})

		expect(calls).toHaveLength(1)
		expect(calls[0]?.values).toEqual({
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			action: 'workspace_knowledge_referenced',
			entityType: 'object',
			entityId: 'knowledge-1',
			data: {
				consumer_context_id: 'bet-1',
				source_topics: ['topic:company_profile', 'topic:market'],
			},
		})
	})

	it('exports the canonical action string constant', () => {
		expect(WORKSPACE_KNOWLEDGE_REFERENCED).toBe('workspace_knowledge_referenced')
	})

	it('emits the PostHog event keyed on workspace with the flattened topic props', async () => {
		const { db } = makeDb()

		await trackWorkspaceKnowledgeReferenced(db, {
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			entityId: 'knowledge-1',
			consumerContextId: 'bet-1',
			sourceTopics: ['topic:company_profile', 'topic:users'],
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith('workspace_knowledge_referenced', 'ws-1', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			entity_id: 'knowledge-1',
			consumer_context_id: 'bet-1',
			source_topic_count: 2,
			source_topics: 'topic:company_profile,topic:users',
		})
	})

	it('accepts a null consumer context (reads that are not tied to a bet/insight/task)', async () => {
		const { db, calls } = makeDb()

		await trackWorkspaceKnowledgeReferenced(db, {
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			entityId: 'knowledge-1',
			consumerContextId: null,
			sourceTopics: [],
		})

		expect((calls[0]?.values as { data: Record<string, unknown> }).data).toEqual({
			consumer_context_id: null,
			source_topics: [],
		})
		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'workspace_knowledge_referenced',
			'ws-1',
			expect.objectContaining({
				consumer_context_id: null,
				source_topic_count: 0,
				source_topics: '',
			}),
		)
	})

	it('still emits to PostHog when the DB insert throws (analytics never blocks the read)', async () => {
		const { db } = makeDb('throw')

		await expect(
			trackWorkspaceKnowledgeReferenced(db, {
				workspaceId: 'ws-1',
				actorId: 'actor-1',
				entityId: 'knowledge-1',
				consumerContextId: 'bet-1',
				sourceTopics: ['topic:company_profile'],
			}),
		).resolves.toBeUndefined()

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
	})
})
