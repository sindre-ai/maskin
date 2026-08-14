import { objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { buildCreateObjectBody, insertObject, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: objectsRoutes } = await import('../../routes/objects')
const { default: graphRoutes } = await import('../../routes/graph')

// Workspace settings that make `knowledge` a valid, statused object type.
// getAllValidTypes() merges module-provided types with Object.keys(settings.statuses),
// so listing 'knowledge' here is enough to pass type/status validation without
// registering the @maskin/ext-knowledge module in this process.
const KNOWLEDGE_WORKSPACE_SETTINGS = {
	enabled_modules: ['work', 'knowledge'],
	display_names: {
		insight: 'Insight',
		bet: 'Bet',
		task: 'Task',
		loop: 'Loop',
		knowledge: 'Article',
	},
	statuses: {
		insight: ['new', 'processing', 'clustered', 'discarded'],
		bet: ['signal', 'proposed', 'active', 'completed', 'succeeded', 'failed', 'paused'],
		task: ['todo', 'in_progress', 'done', 'blocked'],
		loop: ['holding', 'at-risk', 'breached'],
		knowledge: ['draft', 'validated', 'deprecated'],
	},
	field_definitions: {},
	relationship_types: [
		'informs',
		'breaks_into',
		'blocks',
		'relates_to',
		'duplicates',
		'supersedes',
		'contradicts',
		'about',
	],
}

function createApp() {
	return createIntegrationApp(
		{ path: '/api/objects', module: objectsRoutes },
		{ path: '/api/graph', module: graphRoutes },
	)
}

describe('Knowledge duplicate detection', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId, { settings: KNOWLEDGE_WORKSPACE_SETTINGS })
		workspaceId = ws.id
	})

	describe('POST /api/objects', () => {
		it('rejects an exact-title duplicate (case/whitespace-insensitive)', async () => {
			const app = createApp()
			const existing = await insertObject(db, workspaceId, actorId, {
				type: 'knowledge',
				title: 'Deploying   to Staging',
				status: 'validated',
			})

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects',
					buildCreateObjectBody({
						type: 'knowledge',
						title: '  deploying to staging  ',
						status: 'draft',
					}),
					{ 'x-workspace-id': workspaceId },
				),
			)

			expect(res.status).toBe(409)
			const body = await res.json()
			expect(body.error.code).toBe('CONFLICT')
			expect(body.error.message).toContain(existing.id)
		})

		it('rejects a near-duplicate title via substring containment', async () => {
			const app = createApp()
			const existing = await insertObject(db, workspaceId, actorId, {
				type: 'knowledge',
				title: 'Deploying to staging environment',
				status: 'validated',
			})

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects',
					buildCreateObjectBody({
						type: 'knowledge',
						title: 'Deploying to staging',
						status: 'draft',
					}),
					{ 'x-workspace-id': workspaceId },
				),
			)

			expect(res.status).toBe(409)
			const body = await res.json()
			expect(body.error.code).toBe('CONFLICT')
			expect(body.error.message).toContain(existing.id)
		})

		it('does not flag short titles as containment duplicates', async () => {
			const app = createApp()
			await insertObject(db, workspaceId, actorId, {
				type: 'knowledge',
				title: 'API',
				status: 'validated',
			})

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects',
					buildCreateObjectBody({
						type: 'knowledge',
						title: 'API Reference Guide',
						status: 'draft',
					}),
					{ 'x-workspace-id': workspaceId },
				),
			)

			expect(res.status).toBe(201)
		})

		it('does not flag identical titles for non-knowledge types', async () => {
			const app = createApp()
			const first = await app.request(
				jsonRequest(
					'POST',
					'/api/objects',
					buildCreateObjectBody({ type: 'task', title: 'Duplicate Title Test', status: 'todo' }),
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(first.status).toBe(201)

			const second = await app.request(
				jsonRequest(
					'POST',
					'/api/objects',
					buildCreateObjectBody({ type: 'task', title: 'Duplicate Title Test', status: 'todo' }),
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(second.status).toBe(201)
		})

		it('does not block on a deprecated knowledge object with the same title', async () => {
			const app = createApp()
			await insertObject(db, workspaceId, actorId, {
				type: 'knowledge',
				title: 'Old runbook',
				status: 'deprecated',
			})

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects',
					buildCreateObjectBody({ type: 'knowledge', title: 'Old runbook', status: 'draft' }),
					{ 'x-workspace-id': workspaceId },
				),
			)

			expect(res.status).toBe(201)
		})

		it('does not block on an archived knowledge object with the same title', async () => {
			const app = createApp()
			// Inserted directly (bypassing API status validation) since 'archived' isn't
			// in this workspace's knowledge status list, but the dedup filter defends
			// against it defensively — see RETIRED_KNOWLEDGE_STATUSES.
			await insertObject(db, workspaceId, actorId, {
				type: 'knowledge',
				title: 'Ancient doc',
				status: 'archived',
			})

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects',
					buildCreateObjectBody({ type: 'knowledge', title: 'Ancient doc', status: 'draft' }),
					{ 'x-workspace-id': workspaceId },
				),
			)

			expect(res.status).toBe(201)
		})
	})

	describe('POST /api/graph', () => {
		it('rejects a knowledge node that duplicates an existing object', async () => {
			const app = createApp()
			const existing = await insertObject(db, workspaceId, actorId, {
				type: 'knowledge',
				title: 'Runbook: incident response',
				status: 'validated',
			})

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/graph',
					{
						nodes: [
							{
								$id: 'k1',
								type: 'knowledge',
								title: 'Runbook: incident response',
								status: 'draft',
							},
						],
						edges: [],
					},
					{ 'x-workspace-id': workspaceId },
				),
			)

			expect(res.status).toBe(409)
			const body = await res.json()
			expect(body.error.code).toBe('CONFLICT')
			expect(body.error.message).toContain('k1')
			expect(body.error.message).toContain(existing.id)
		})

		it('rejects two duplicate knowledge nodes within the same batch', async () => {
			const app = createApp()

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/graph',
					{
						nodes: [
							{ $id: 'k1', type: 'knowledge', title: 'Onboarding guide', status: 'draft' },
							{ $id: 'k2', type: 'knowledge', title: 'Onboarding guide', status: 'draft' },
						],
						edges: [],
					},
					{ 'x-workspace-id': workspaceId },
				),
			)

			expect(res.status).toBe(409)
			const body = await res.json()
			expect(body.error.code).toBe('CONFLICT')
			expect(body.error.message).toContain('k1')
			expect(body.error.message).toContain('k2')
		})
	})

	// The route-level preflight in findKnowledgeDuplicate() runs before the
	// INSERT — so two concurrent POSTs with the same title can both pass the
	// preflight and race into the insert. The partial unique index shipped in
	// migration 0047 is the DB-side backstop; without it, both writes would
	// succeed and the "hard guardrail" claim would break. The two tests below
	// verify the invariant (only one live row survives) and the 409 shape the
	// concurrent-write branch returns.
	describe('concurrent writes (TOCTOU backstop)', () => {
		it('lets only one of many concurrent POST /api/objects with the same title win', async () => {
			const app = createApp()
			const title = 'Concurrent racing runbook'
			const attempts = 8

			const results = await Promise.all(
				Array.from({ length: attempts }, () =>
					app.request(
						jsonRequest(
							'POST',
							'/api/objects',
							buildCreateObjectBody({ type: 'knowledge', title, status: 'draft' }),
							{ 'x-workspace-id': workspaceId },
						),
					),
				),
			)

			const statuses = results.map((r) => r.status).sort()
			const winners = statuses.filter((s) => s === 201)
			const losers = statuses.filter((s) => s === 409)

			expect(winners.length).toBe(1)
			expect(winners.length + losers.length).toBe(attempts)

			// Every loser must be a CONFLICT (not a 500 from an unhandled
			// unique-violation).
			for (const res of results) {
				if (res.status === 201) continue
				expect(res.status).toBe(409)
				const body = await res.json()
				expect(body.error.code).toBe('CONFLICT')
			}

			// And the DB must hold exactly one live knowledge row with that title —
			// the partial unique index does what the preflight alone couldn't.
			const surviving = await db
				.select({ id: objects.id })
				.from(objects)
				.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'knowledge')))
			expect(surviving.length).toBe(1)
		})

		it('rejects a concurrent POST /api/graph batch when the DB constraint fires', async () => {
			const app = createApp()
			const title = 'Racing graph batch runbook'
			const attempts = 4

			const results = await Promise.all(
				Array.from({ length: attempts }, (_, i) =>
					app.request(
						jsonRequest(
							'POST',
							'/api/graph',
							{
								nodes: [{ $id: `k${i}`, type: 'knowledge', title, status: 'draft' }],
								edges: [],
							},
							{ 'x-workspace-id': workspaceId },
						),
					),
				),
			)

			const winners = results.filter((r) => r.status === 201)
			const losers = results.filter((r) => r.status === 409)
			expect(winners.length).toBe(1)
			expect(winners.length + losers.length).toBe(attempts)

			for (const res of losers) {
				const body = await res.json()
				expect(body.error.code).toBe('CONFLICT')
			}

			const surviving = await db
				.select({ id: objects.id })
				.from(objects)
				.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'knowledge')))
			expect(surviving.length).toBe(1)
		})
	})
})
