import { events, objects } from '@maskin/db/schema'
import { retrieveKnowledge } from '@maskin/ext-knowledge/retrieval'
import { and, eq } from 'drizzle-orm'
import { buildCreateRelationshipBody, insertObject, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: relationshipsRoutes } = await import('../../routes/relationships')
const { default: objectsRoutes } = await import('../../routes/objects')

function createApp() {
	return createIntegrationApp({ path: '/api/relationships', module: relationshipsRoutes })
}

function createObjectsApp() {
	return createIntegrationApp({ path: '/api/objects', module: objectsRoutes })
}

async function seedKnowledge(
	workspaceId: string,
	actorId: string,
	overrides?: Record<string, unknown>,
) {
	return insertObject(db, workspaceId, actorId, {
		type: 'knowledge',
		status: 'draft',
		...overrides,
	})
}

function metadataOf(row: { metadata: unknown } | undefined) {
	return row?.metadata as Record<string, unknown> | null | undefined
}

describe('knowledge metadata — live-only filters, ranking, bi-temporal stamping', () => {
	let workspaceId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
	})

	// ── retrieveKnowledge() filter/rank behavior ───────────────────────────────

	it('excludes rows with metadata.t_invalid set (bi-temporal live-only)', async () => {
		const live = await seedKnowledge(workspaceId, getTestActorId(), {
			title: 'MCP tool response trimming defaults',
			content: 'The ecosystem has converged on field projection.',
		})
		const invalidated = await seedKnowledge(workspaceId, getTestActorId(), {
			title: 'MCP tool response defaults (superseded)',
			content: 'Older take on field projection — kept for audit.',
			metadata: { t_invalid: new Date().toISOString() },
		})

		const results = await retrieveKnowledge(db, {
			workspaceId,
			q: 'MCP tool response defaults projection',
			limit: 10,
			offset: 0,
		})

		const ids = results.map((r) => r.id)
		expect(ids).toContain(live.id)
		expect(ids).not.toContain(invalidated.id)
	})

	it('excludes rows with a future metadata.t_valid', async () => {
		const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
		const notYetLive = await seedKnowledge(workspaceId, getTestActorId(), {
			title: 'Scheduled knowledge row — not yet valid',
			content: 'Body about scheduled validity handling.',
			metadata: { t_valid: future },
		})
		const live = await seedKnowledge(workspaceId, getTestActorId(), {
			title: 'Scheduled knowledge row — already valid',
			content: 'Body about scheduled validity handling.',
		})

		const results = await retrieveKnowledge(db, {
			workspaceId,
			q: 'scheduled validity handling',
			limit: 10,
			offset: 0,
		})

		const ids = results.map((r) => r.id)
		expect(ids).toContain(live.id)
		expect(ids).not.toContain(notYetLive.id)
	})

	it('does not error on a malformed metadata.t_valid / t_invalid value', async () => {
		await seedKnowledge(workspaceId, getTestActorId(), {
			title: 'Malformed validity metadata row',
			content: 'Body about malformed metadata handling.',
			metadata: { t_valid: 'not-a-real-date', t_invalid: 'also-not-a-date' },
		})

		await expect(
			retrieveKnowledge(db, {
				workspaceId,
				q: 'malformed metadata handling',
				limit: 10,
				offset: 0,
			}),
		).resolves.not.toThrow()
	})

	it('ranks higher verification and confidence above lower ones when multiple rows match', async () => {
		const low = await seedKnowledge(workspaceId, getTestActorId(), {
			title: 'Retrieval ranking — early note',
			content: 'Draft claim about retrieval ranking behaviour.',
			metadata: { confidence: 'low', verification_status: 'unverified' },
		})
		const high = await seedKnowledge(workspaceId, getTestActorId(), {
			title: 'Retrieval ranking — confirmed pattern',
			content: 'Verified claim about retrieval ranking behaviour.',
			metadata: { confidence: 'high', verification_status: 'verified' },
		})

		const results = await retrieveKnowledge(db, {
			workspaceId,
			q: 'retrieval ranking behaviour',
			limit: 10,
			offset: 0,
		})

		expect(results[0]?.id).toBe(high.id)
		expect(results.map((r) => r.id)).toContain(low.id)
	})

	it('excludes rows with metadata.verification_status=deprecated', async () => {
		const ok = await seedKnowledge(workspaceId, getTestActorId(), {
			title: 'Deprecation eval — active row',
			content: 'Body about deprecation handling.',
			metadata: { confidence: 'medium', verification_status: 'verified' },
		})
		const deprecated = await seedKnowledge(workspaceId, getTestActorId(), {
			title: 'Deprecation eval — retired row',
			content: 'Body about deprecation handling.',
			metadata: { confidence: 'high', verification_status: 'deprecated' },
		})

		const results = await retrieveKnowledge(db, {
			workspaceId,
			q: 'deprecation eval handling',
			limit: 10,
			offset: 0,
		})

		const ids = results.map((r) => r.id)
		expect(ids).toContain(ok.id)
		expect(ids).not.toContain(deprecated.id)
	})

	// ── Board route (read-path knowledge gate) ─────────────────────────────────

	it('board route excludes invalidated/deprecated knowledge rows that list/search already hide', async () => {
		const boardWs = await insertWorkspace(db, getTestActorId(), {
			settings: { enabled_modules: ['knowledge'] },
		})
		const live = await seedKnowledge(boardWs.id, getTestActorId(), { status: 'validated' })
		const invalidated = await seedKnowledge(boardWs.id, getTestActorId(), {
			status: 'validated',
			metadata: { t_invalid: new Date().toISOString() },
		})
		const deprecatedRow = await seedKnowledge(boardWs.id, getTestActorId(), {
			status: 'validated',
			metadata: { verification_status: 'deprecated' },
		})

		const app = createObjectsApp()
		const res = await app.request(
			jsonGet('/api/objects/board?type=knowledge&groupBy=status', {
				'x-workspace-id': boardWs.id,
			}),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			columns: Array<{ value: string; total: number; objects: Array<{ id: string }> }>
		}
		const column = body.columns.find((c) => c.value === 'validated')
		expect(column).toBeDefined()
		const ids = column?.objects.map((o) => o.id) ?? []
		expect(ids).toContain(live.id)
		expect(ids).not.toContain(invalidated.id)
		expect(ids).not.toContain(deprecatedRow.id)
		expect(column?.total).toBe(1)
	})

	it('board route is unaffected for non-knowledge types (no behavior change)', async () => {
		const insight = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'insight',
			status: 'new',
		})

		const app = createObjectsApp()
		const res = await app.request(
			jsonGet('/api/objects/board?type=insight&groupBy=status', {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			columns: Array<{ value: string; objects: Array<{ id: string }> }>
		}
		const column = body.columns.find((c) => c.value === 'new')
		expect(column?.objects.map((o) => o.id)).toContain(insight.id)
	})

	// ── Bi-temporal write path ──────────────────────────────────────────────────

	it('creating a supersedes edge between two knowledge objects stamps metadata.t_invalid on the target', async () => {
		const app = createApp()
		const oldKnowledge = await seedKnowledge(workspaceId, getTestActorId(), {
			metadata: { confidence: 'high', verification_status: 'verified' },
		})
		const newKnowledge = await seedKnowledge(workspaceId, getTestActorId())

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				buildCreateRelationshipBody({
					source_type: 'knowledge',
					source_id: newKnowledge.id,
					target_type: 'knowledge',
					target_id: oldKnowledge.id,
					type: 'supersedes',
				}),
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(201)

		const [row] = await db.select().from(objects).where(eq(objects.id, oldKnowledge.id))
		const metadata = metadataOf(row)
		expect(metadata?.t_invalid).toBeTruthy()
		// Pre-existing metadata keys must NOT be clobbered.
		expect(metadata?.confidence).toBe('high')
		expect(metadata?.verification_status).toBe('verified')

		// AC: the row itself must still exist (not deleted).
		expect(row?.id).toBe(oldKnowledge.id)
	})

	it('creating a contradicts edge stamps metadata.t_invalid on the target', async () => {
		const app = createApp()
		const oldKnowledge = await seedKnowledge(workspaceId, getTestActorId())
		const newKnowledge = await seedKnowledge(workspaceId, getTestActorId())

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				buildCreateRelationshipBody({
					source_type: 'knowledge',
					source_id: newKnowledge.id,
					target_type: 'knowledge',
					target_id: oldKnowledge.id,
					type: 'contradicts',
				}),
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(201)

		const [row] = await db.select().from(objects).where(eq(objects.id, oldKnowledge.id))
		expect(metadataOf(row)?.t_invalid).toBeTruthy()
	})

	it('non-knowledge supersede edge does NOT touch object metadata', async () => {
		const app = createApp()
		const insight = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'insight',
			status: 'new',
		})
		const bet = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'bet',
			status: 'signal',
		})

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				buildCreateRelationshipBody({
					source_type: 'bet',
					source_id: bet.id,
					target_type: 'insight',
					target_id: insight.id,
					type: 'supersedes',
				}),
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(201)

		const [row] = await db.select().from(objects).where(eq(objects.id, insight.id))
		expect(row?.metadata).toBeNull()
	})

	it('supersede is idempotent — re-stamping preserves other metadata and updates t_invalid', async () => {
		const app = createApp()
		const oldKnowledge = await seedKnowledge(workspaceId, getTestActorId(), {
			metadata: {
				confidence: 'high',
				verification_status: 'verified',
				t_invalid: '2020-01-01T00:00:00.000Z',
			},
		})
		const newKnowledge = await seedKnowledge(workspaceId, getTestActorId())

		await app.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				buildCreateRelationshipBody({
					source_type: 'knowledge',
					source_id: newKnowledge.id,
					target_type: 'knowledge',
					target_id: oldKnowledge.id,
					type: 'supersedes',
				}),
				{ 'x-workspace-id': workspaceId },
			),
		)

		const [row] = await db.select().from(objects).where(eq(objects.id, oldKnowledge.id))
		const metadata = metadataOf(row)
		expect(metadata?.t_invalid).not.toBe('2020-01-01T00:00:00.000Z')
		expect(metadata?.confidence).toBe('high')
		expect(metadata?.verification_status).toBe('verified')
	})

	it('stamping t_invalid logs an events row for the audit trail', async () => {
		const app = createApp()
		const oldKnowledge = await seedKnowledge(workspaceId, getTestActorId())
		const newKnowledge = await seedKnowledge(workspaceId, getTestActorId())

		await app.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				buildCreateRelationshipBody({
					source_type: 'knowledge',
					source_id: newKnowledge.id,
					target_type: 'knowledge',
					target_id: oldKnowledge.id,
					type: 'supersedes',
				}),
				{ 'x-workspace-id': workspaceId },
			),
		)

		const rows = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, oldKnowledge.id), eq(events.action, 'updated')))
		expect(rows.length).toBeGreaterThan(0)
	})
})
