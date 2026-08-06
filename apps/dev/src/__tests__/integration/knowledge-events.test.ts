import { events } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import {
	WORKSPACE_KNOWLEDGE_REFERENCED,
	trackWorkspaceKnowledgeReferenced,
} from '../../lib/analytics/knowledge-events'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// PostHog is stubbed at the module boundary so the integration test proves
// the DB half of the pipeline (audit row + payload shape) without needing
// a live PostHog project. The unit tests cover the PostHog call shape.
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

describe('workspace_knowledge_referenced — events pipeline integration', () => {
	let workspaceId: string
	let knowledgeObjectId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const obj = await insertObject(db, workspaceId, getTestActorId(), { type: 'knowledge' })
		knowledgeObjectId = obj.id
	})

	it('accepts the workspace_knowledge_referenced action end-to-end with the ADR payload shape', async () => {
		await trackWorkspaceKnowledgeReferenced(db, {
			workspaceId,
			actorId: getTestActorId(),
			entityId: knowledgeObjectId,
			consumerContextId: knowledgeObjectId,
			sourceTopics: ['topic:company_profile', 'topic:market'],
		})

		const rows = await db
			.select()
			.from(events)
			.where(
				and(
					eq(events.workspaceId, workspaceId),
					eq(events.action, WORKSPACE_KNOWLEDGE_REFERENCED),
					eq(events.entityId, knowledgeObjectId),
				),
			)

		expect(rows).toHaveLength(1)
		const row = rows[0]
		expect(row.action).toBe('workspace_knowledge_referenced')
		expect(row.entityType).toBe('object')
		expect(row.actorId).toBe(getTestActorId())
		expect(row.data).toEqual({
			consumer_context_id: knowledgeObjectId,
			source_topics: ['topic:company_profile', 'topic:market'],
		})
	})
})
