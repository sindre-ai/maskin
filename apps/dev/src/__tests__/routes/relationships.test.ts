import { vi } from 'vitest'
import {
	buildCreateRelationshipBody,
	buildObject,
	buildRelationship,
	buildWorkspaceMember,
} from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

const { default: relationshipsRoutes } = await import('../../routes/relationships')

const wsId = '00000000-0000-0000-0000-000000000001'

describe('Relationships Routes', () => {
	describe('POST /api/relationships', () => {
		it('creates a relationship and returns 201', async () => {
			const rel = buildRelationship()
			const { app, mockResults, calls } = createTestApp(relationshipsRoutes, '/api/relationships')
			mockResults.insert = [rel]

			const res = await app.request(
				jsonRequest('POST', '/api/relationships', buildCreateRelationshipBody(), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(rel.id)
			expect(body.type).toBe('informs')
		})

		it('resolves canonical types server-side, ignoring caller-supplied labels', async () => {
			const rel = buildRelationship()
			// No select mock needed — files query returns [] by default,
			// so both endpoints resolve to 'object'
			const { app, mockResults, calls } = createTestApp(relationshipsRoutes, '/api/relationships')
			mockResults.insert = [rel]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/relationships',
					{
						source_type: 'insight',
						source_id: '00000000-0000-0000-0000-000000000001',
						target_type: 'bet',
						target_id: '00000000-0000-0000-0000-000000000002',
						type: 'informs',
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)

			// Verify the values passed to the insert are the canonical types,
			// not the caller-supplied 'insight'/'bet'
			const insertValues = calls.inserts[0] as Record<string, unknown>
			expect(insertValues.sourceType).toBe('object')
			expect(insertValues.targetType).toBe('object')
		})

		it('returns 201 with the existing row on a duplicate insert and does not re-fire events', async () => {
			const rel = buildRelationship({ type: 'derived_from' })
			const { app, mockResults, calls } = createTestApp(relationshipsRoutes, '/api/relationships')
			// ON CONFLICT DO NOTHING → insert returns []; the follow-up SELECT
			// then finds the existing row so the route returns 201 without
			// firing the audit event or the ship-metric emit.
			mockResults.insert = []
			mockResults.selectQueue = [[], [rel]]
			capturePosthogEventMock.mockClear()

			const res = await app.request(
				jsonRequest('POST', '/api/relationships', buildCreateRelationshipBody(), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(rel.id)
			// The route only calls db.insert(relationships) — no `events` insert,
			// because that only fires when a fresh row comes back from the ON CONFLICT.
			expect(calls.inserts).toHaveLength(1)
			expect(capturePosthogEventMock).not.toHaveBeenCalled()
		})

		it('auto-emits workspace_knowledge_referenced when a fresh derived_from targets a knowledge object', async () => {
			const source = buildObject({ type: 'bet' })
			const target = buildObject({
				type: 'knowledge',
				metadata: { tags: ['topic:company_profile', 'topic:market'] },
			})
			const rel = buildRelationship({
				sourceId: source.id,
				targetId: target.id,
				type: 'derived_from',
			})
			const { app, mockResults, calls } = createTestApp(relationshipsRoutes, '/api/relationships')
			// Select order inside the handler:
			//   1) files lookup for source_type/target_type resolution → []
			//   2) hook's `objects` lookup on the target → knowledge row
			mockResults.selectQueue = [[], [{ type: target.type, metadata: target.metadata }]]
			mockResults.insert = [rel]
			capturePosthogEventMock.mockClear()

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/relationships',
					{
						source_type: 'object',
						source_id: source.id,
						target_type: 'object',
						target_id: target.id,
						type: 'derived_from',
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			// One insert on `relationships`, one on `events` (audit created), one on
			// `events` (workspace_knowledge_referenced audit row). No emit for
			// other relationship types keeps this bounded.
			expect(calls.inserts).toHaveLength(3)
			const shipMetric = calls.inserts.find(
				(v) => (v as Record<string, unknown>).action === 'workspace_knowledge_referenced',
			) as Record<string, unknown>
			expect(shipMetric).toMatchObject({
				workspaceId: wsId,
				entityType: 'object',
				entityId: target.id,
				data: {
					consumer_context_id: source.id,
					source_topics: ['topic:company_profile', 'topic:market'],
				},
			})
			expect(capturePosthogEventMock).toHaveBeenCalledWith(
				'workspace_knowledge_referenced',
				wsId,
				expect.objectContaining({
					entity_id: target.id,
					consumer_context_id: source.id,
					source_topics: 'topic:company_profile,topic:market',
					source_topic_count: 2,
				}),
			)
		})

		it('does not auto-emit for non-derived_from edge types', async () => {
			const rel = buildRelationship({ type: 'informs' })
			const { app, mockResults, calls } = createTestApp(relationshipsRoutes, '/api/relationships')
			mockResults.insert = [rel]
			capturePosthogEventMock.mockClear()

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/relationships',
					{
						source_type: 'object',
						source_id: rel.sourceId,
						target_type: 'object',
						target_id: rel.targetId,
						type: 'informs',
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			// relationships insert + audit events insert = 2. No ship-metric row.
			expect(calls.inserts).toHaveLength(2)
			expect(
				calls.inserts.every(
					(v) => (v as Record<string, unknown>).action !== 'workspace_knowledge_referenced',
				),
			).toBe(true)
			expect(capturePosthogEventMock).not.toHaveBeenCalled()
		})
	})

	describe('GET /api/relationships', () => {
		it('returns 200 with list of relationships', async () => {
			const r1 = buildRelationship()
			const r2 = buildRelationship({ type: 'breaks_into' })
			const { app, mockResults } = createTestApp(relationshipsRoutes, '/api/relationships')
			mockResults.select = [r1, r2]

			const res = await app.request(jsonGet('/api/relationships'))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
		})
	})

	describe('DELETE /api/relationships/:id', () => {
		it('returns 200 when deleted', async () => {
			const sourceObj = buildObject()
			const rel = buildRelationship({ sourceId: sourceObj.id })
			const { app, mockResults } = createTestApp(relationshipsRoutes, '/api/relationships')
			// First select: relationship, second: source object lookup, third: membership check
			mockResults.selectQueue = [[rel], [sourceObj], [buildWorkspaceMember()]]
			mockResults.insert = [{}] // event

			const res = await app.request(
				jsonDelete(`/api/relationships/${rel.id}`, {
					'X-Workspace-Id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.deleted).toBe(true)
		})

		it('returns 404 when relationship not found', async () => {
			const { app } = createTestApp(relationshipsRoutes, '/api/relationships')

			const res = await app.request(
				jsonDelete('/api/relationships/00000000-0000-0000-0000-000000000099'),
			)

			expect(res.status).toBe(404)
		})
	})
})
