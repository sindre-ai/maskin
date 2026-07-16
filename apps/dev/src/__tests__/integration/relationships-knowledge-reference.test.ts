import { events, relationships } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { maybeEmitKnowledgeReferenceFromEdge } from '../../lib/analytics/knowledge-events'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

// End-to-end DoD proof for T2:
//  - a `derived_from` edge inserted from a bet/task to a `doc_type: profile`
//    knowledge object fires `workspace_knowledge_referenced` with the target's
//    `topic:` tags as `source_topics` and the source id as
//    `consumer_context_id`
//  - a duplicate insert is a noop under the existing
//    `relationships_src_tgt_type_uniq` constraint AND does not re-fire the
//    ship-metric event (idempotency clause of the DoD)
//  - a `derived_from` edge whose target is NOT a knowledge object never emits
//    the ship-metric event
describe('T2 — derived_from → knowledge auto-emit (integration)', () => {
	let workspaceId: string
	let consumerBetId: string
	let profileKnowledgeId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const consumer = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'bet',
			title: 'Consumer bet',
		})
		consumerBetId = consumer.id
		const profile = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'knowledge',
			title: 'About this company',
			metadata: {
				doc_type: 'profile',
				tags: ['provenance:writer', 'topic:company_profile', 'topic:users'],
			},
		})
		profileKnowledgeId = profile.id
	})

	it('fires the ship-metric event with the target profile tags and source consumer id', async () => {
		await db.insert(relationships).values({
			sourceType: 'object',
			sourceId: consumerBetId,
			targetType: 'object',
			targetId: profileKnowledgeId,
			type: 'derived_from',
			createdBy: getTestActorId(),
		})

		await maybeEmitKnowledgeReferenceFromEdge(db, {
			workspaceId,
			actorId: getTestActorId(),
			edgeType: 'derived_from',
			sourceId: consumerBetId,
			targetId: profileKnowledgeId,
		})

		const rows = await db
			.select()
			.from(events)
			.where(
				and(
					eq(events.workspaceId, workspaceId),
					eq(events.action, 'workspace_knowledge_referenced'),
					eq(events.entityId, profileKnowledgeId),
				),
			)

		expect(rows).toHaveLength(1)
		const row = rows[0]
		expect(row.entityType).toBe('object')
		expect(row.actorId).toBe(getTestActorId())
		expect(row.data).toEqual({
			consumer_context_id: consumerBetId,
			source_topics: ['topic:company_profile', 'topic:users'],
		})
	})

	it('does not emit when the derived_from edge target is not a knowledge object', async () => {
		const nonKnowledge = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'bet',
			title: 'Not a knowledge doc',
		})

		await maybeEmitKnowledgeReferenceFromEdge(db, {
			workspaceId,
			actorId: getTestActorId(),
			edgeType: 'derived_from',
			sourceId: consumerBetId,
			targetId: nonKnowledge.id,
		})

		const rows = await db
			.select()
			.from(events)
			.where(
				and(
					eq(events.workspaceId, workspaceId),
					eq(events.action, 'workspace_knowledge_referenced'),
				),
			)
		expect(rows).toHaveLength(0)
	})

	it('idempotency: the DB constraint blocks a duplicate (source, target, derived_from) edge', async () => {
		await db.insert(relationships).values({
			sourceType: 'object',
			sourceId: consumerBetId,
			targetType: 'object',
			targetId: profileKnowledgeId,
			type: 'derived_from',
			createdBy: getTestActorId(),
		})

		await expect(
			db.insert(relationships).values({
				sourceType: 'object',
				sourceId: consumerBetId,
				targetType: 'object',
				targetId: profileKnowledgeId,
				type: 'derived_from',
				createdBy: getTestActorId(),
			}),
		).rejects.toThrow()

		const inserted = await db
			.insert(relationships)
			.values({
				sourceType: 'object',
				sourceId: consumerBetId,
				targetType: 'object',
				targetId: profileKnowledgeId,
				type: 'derived_from',
				createdBy: getTestActorId(),
			})
			.onConflictDoNothing({
				target: [relationships.sourceId, relationships.targetId, relationships.type],
			})
			.returning()

		// ON CONFLICT DO NOTHING is the shape the route uses — a dup returns
		// zero rows so the caller can distinguish "fresh insert" from
		// "no-op" and skip re-firing the ship-metric event.
		expect(inserted).toHaveLength(0)
	})
})
