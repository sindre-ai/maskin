import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	KNOWLEDGE_OBJECT_CREATED,
	KNOWLEDGE_OBJECT_READ,
	WORKSPACE_KNOWLEDGE_REFERENCED,
	maybeEmitKnowledgeReferenceFromEdge,
	resolveAccessedVia,
	resolveCreatedVia,
	trackKnowledgeObjectCreated,
	trackKnowledgeObjectRead,
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

// Edge hook (called from POST /api/relationships + /api/graph): loads the
// target object, checks it's a `knowledge` row, and fires the ship-metric
// helper with the `topic:` tags from the target's metadata. Only fires on
// `derived_from` edges — every other type must be a noop.
function makeHookDb(opts: {
	targetType?: string | null
	targetMetadata?: unknown
	selectThrows?: boolean
}) {
	const insertCalls: InsertCall[] = []
	const selectCalls: unknown[] = []
	const insert = vi.fn().mockImplementation(() => ({
		values: (row: Record<string, unknown>) => {
			insertCalls.push({ values: row })
			return Promise.resolve()
		},
	}))
	const select = vi.fn().mockImplementation(() => ({
		from: () => ({
			where: () => ({
				limit: () => {
					selectCalls.push(true)
					if (opts.selectThrows) return Promise.reject(new Error('db down'))
					if (opts.targetType === null) return Promise.resolve([])
					return Promise.resolve([{ type: opts.targetType, metadata: opts.targetMetadata ?? null }])
				},
			}),
		}),
	}))
	return {
		db: { insert, select } as unknown as Parameters<typeof maybeEmitKnowledgeReferenceFromEdge>[0],
		insertCalls,
		selectCalls,
	}
}

describe('maybeEmitKnowledgeReferenceFromEdge', () => {
	it('emits when a fresh derived_from edge targets a knowledge object', async () => {
		const { db, insertCalls } = makeHookDb({
			targetType: 'knowledge',
			targetMetadata: { tags: ['topic:company_profile', 'topic:users', 'provenance:writer'] },
		})

		await maybeEmitKnowledgeReferenceFromEdge(db, {
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			edgeType: 'derived_from',
			sourceId: 'bet-1',
			targetId: 'knowledge-1',
		})

		expect(insertCalls).toHaveLength(1)
		expect(insertCalls[0]?.values).toEqual({
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			action: 'workspace_knowledge_referenced',
			entityType: 'object',
			entityId: 'knowledge-1',
			data: {
				consumer_context_id: 'bet-1',
				source_topics: ['topic:company_profile', 'topic:users'],
			},
		})
		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
	})

	it('parses tags stored as a comma-joined string (legacy corpus shape)', async () => {
		const { db, insertCalls } = makeHookDb({
			targetType: 'knowledge',
			targetMetadata: { tags: 'topic:market, topic:competitors,provenance:writer' },
		})

		await maybeEmitKnowledgeReferenceFromEdge(db, {
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			edgeType: 'derived_from',
			sourceId: 'task-1',
			targetId: 'knowledge-1',
		})

		expect(insertCalls[0]?.values).toMatchObject({
			data: {
				consumer_context_id: 'task-1',
				source_topics: ['topic:market', 'topic:competitors'],
			},
		})
	})

	it('does not fire on non-derived_from edge types', async () => {
		const { db, insertCalls, selectCalls } = makeHookDb({ targetType: 'knowledge' })

		await maybeEmitKnowledgeReferenceFromEdge(db, {
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			edgeType: 'informs',
			sourceId: 'bet-1',
			targetId: 'knowledge-1',
		})

		expect(insertCalls).toHaveLength(0)
		expect(selectCalls).toHaveLength(0)
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('does not fire when the target is not a knowledge object', async () => {
		const { db, insertCalls } = makeHookDb({ targetType: 'bet' })

		await maybeEmitKnowledgeReferenceFromEdge(db, {
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			edgeType: 'derived_from',
			sourceId: 'task-1',
			targetId: 'bet-1',
		})

		expect(insertCalls).toHaveLength(0)
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('does not fire when the target row is missing', async () => {
		const { db, insertCalls } = makeHookDb({ targetType: null })

		await maybeEmitKnowledgeReferenceFromEdge(db, {
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			edgeType: 'derived_from',
			sourceId: 'task-1',
			targetId: 'ghost-1',
		})

		expect(insertCalls).toHaveLength(0)
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('swallows lookup errors so an analytics failure never propagates to the caller', async () => {
		const { db, insertCalls } = makeHookDb({ selectThrows: true })

		await expect(
			maybeEmitKnowledgeReferenceFromEdge(db, {
				workspaceId: 'ws-1',
				actorId: 'actor-1',
				edgeType: 'derived_from',
				sourceId: 'task-1',
				targetId: 'knowledge-1',
			}),
		).resolves.toBeUndefined()

		expect(insertCalls).toHaveLength(0)
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('emits with an empty source_topics list when the knowledge object has no topic: tags', async () => {
		const { db, insertCalls } = makeHookDb({
			targetType: 'knowledge',
			targetMetadata: { tags: ['provenance:writer'] },
		})

		await maybeEmitKnowledgeReferenceFromEdge(db, {
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			edgeType: 'derived_from',
			sourceId: 'bet-1',
			targetId: 'knowledge-1',
		})

		expect(insertCalls[0]?.values).toMatchObject({
			data: {
				consumer_context_id: 'bet-1',
				source_topics: [],
			},
		})
	})
})

describe('resolveCreatedVia', () => {
	it('honours an explicit mcp header', () => {
		expect(resolveCreatedVia('mcp', 'human')).toBe('mcp')
		expect(resolveCreatedVia('mcp', 'agent')).toBe('mcp')
	})

	it('honours an explicit agent header', () => {
		expect(resolveCreatedVia('agent', 'human')).toBe('agent')
	})

	it('honours an explicit ui header even for an agent actor', () => {
		expect(resolveCreatedVia('ui', 'agent')).toBe('ui')
	})

	it('falls back to `agent` when actorType=agent and no header is set', () => {
		expect(resolveCreatedVia(undefined, 'agent')).toBe('agent')
	})

	it('falls back to `ui` for a human actor with no header', () => {
		expect(resolveCreatedVia(undefined, 'human')).toBe('ui')
	})

	it('falls back to `ui` when both header and actorType are missing', () => {
		expect(resolveCreatedVia(undefined, undefined)).toBe('ui')
	})

	it('ignores an unrecognised header value', () => {
		expect(resolveCreatedVia('lol', 'human')).toBe('ui')
	})
})

describe('resolveAccessedVia', () => {
	it('honours the extension header (only path with an explicit slot)', () => {
		expect(resolveAccessedVia('extension', 'human')).toBe('extension')
	})

	it('honours an explicit mcp header', () => {
		expect(resolveAccessedVia('mcp', 'human')).toBe('mcp')
	})

	it('honours an explicit ui header', () => {
		expect(resolveAccessedVia('ui', 'agent')).toBe('ui')
	})

	// The read-side enum has no `agent` value per the task spec; agents that
	// read without MCP fall through to `mcp` because that is the intended
	// agent read path.
	it('maps a headerless agent actor to `mcp`', () => {
		expect(resolveAccessedVia(undefined, 'agent')).toBe('mcp')
	})

	it('falls back to `ui` for a headerless human actor', () => {
		expect(resolveAccessedVia(undefined, 'human')).toBe('ui')
	})
})

describe('trackKnowledgeObjectCreated', () => {
	it('captures the ship-metric event with the flattened prop shape', async () => {
		await trackKnowledgeObjectCreated({
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			objectId: 'knowledge-1',
			createdVia: 'mcp',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith(KNOWLEDGE_OBJECT_CREATED, 'ws-1', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			object_id: 'knowledge-1',
			created_via: 'mcp',
		})
	})

	it('exports the canonical event-name constant', () => {
		expect(KNOWLEDGE_OBJECT_CREATED).toBe('knowledge_object_created')
	})
})

describe('trackKnowledgeObjectRead', () => {
	it('captures the ship-metric event with the flattened prop shape', async () => {
		await trackKnowledgeObjectRead({
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			objectId: 'knowledge-1',
			accessedVia: 'ui',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith(KNOWLEDGE_OBJECT_READ, 'ws-1', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			object_id: 'knowledge-1',
			accessed_via: 'ui',
		})
	})

	it('exports the canonical event-name constant', () => {
		expect(KNOWLEDGE_OBJECT_READ).toBe('knowledge_object_read')
	})
})
