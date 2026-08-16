import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { objects, relationships, workspaceOnboardingPrompts } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { insertActor, insertObject, insertRelationship, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId, sql } from './global-setup'

const { default: graphRoutes } = await import('../../routes/graph')

const KNOWLEDGE_WORKSPACE_SETTINGS = {
	enabled_modules: ['work', 'knowledge'],
	display_names: {
		insight: 'Insight',
		bet: 'Bet',
		task: 'Task',
		loop: 'Loop',
		knowledge: 'Article',
		onboarding_session: 'Onboarding session',
	},
	statuses: {
		insight: ['new', 'processing', 'clustered', 'discarded'],
		bet: ['signal', 'proposed', 'active', 'completed', 'succeeded', 'failed', 'paused'],
		task: ['todo', 'in_progress', 'done', 'blocked'],
		loop: ['holding', 'at-risk', 'breached'],
		knowledge: ['draft', 'validated', 'deprecated'],
		onboarding_session: ['active', 'done'],
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
	return createIntegrationApp({ path: '/api/graph', module: graphRoutes })
}

// Locate the T7 backfill file directly rather than re-encoding its SQL in the
// test — the migration is the artifact we want to verify, and reading it from
// disk guarantees the test is exercising the shipped statements.
const __dirname = dirname(fileURLToPath(import.meta.url))
const BACKFILL_SQL_PATH = join(
	__dirname,
	'..',
	'..',
	'..',
	'..',
	'..',
	'packages',
	'db',
	'drizzle',
	'0053_backfill_onboarding_about_edges.sql',
)

async function runBackfill() {
	const content = readFileSync(BACKFILL_SQL_PATH, 'utf-8')
	for (const statement of splitStatements(content)) {
		await sql.unsafe(statement)
	}
}

describe('T7 — onboarding capture writes `about` edge with the knowledge row', () => {
	let workspaceId: string
	let ownerActorId: string

	beforeEach(async () => {
		ownerActorId = getTestActorId()
		const ws = await insertWorkspace(db, ownerActorId, {
			settings: KNOWLEDGE_WORKSPACE_SETTINGS,
		})
		workspaceId = ws.id
	})

	describe('new write path — one atomic create_objects call', () => {
		it('creates the knowledge row AND the `about → owner` edge in the same transaction for an owner-targeted reply', async () => {
			const app = createApp()
			const session = await insertObject(db, workspaceId, ownerActorId, {
				type: 'onboarding_session',
				title: 'Getting your workspace ready',
				status: 'active',
			})

			const validFrom = new Date().toISOString()
			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/graph',
					{
						nodes: [
							{
								$id: 'k1',
								type: 'knowledge',
								title: 'Product vision',
								status: 'validated',
								content: 'We help small teams ship faster by turning intent into structured bets.',
								metadata: {
									source: 'workspace_onboarding',
									prompt_key: 'product_vision',
									subject_kind: 'workspace_owner',
									subject_id: ownerActorId,
									claim: 'Help small teams ship faster via intent-to-bet.',
									confidence: 'medium',
									valid_from: validFrom,
									valid_to: null,
									tags: ['onboarding', 'provenance:workspace_onboarding'],
								},
							},
						],
						edges: [
							{ source: 'k1', target: ownerActorId, type: 'about' },
							{ source: 'k1', target: session.id, type: 'relates_to' },
						],
					},
					{ 'x-workspace-id': workspaceId },
				),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.nodes).toHaveLength(1)
			expect(body.edges).toHaveLength(2)

			const knowledgeId = body.nodes[0].id
			const [row] = await db.select().from(objects).where(eq(objects.id, knowledgeId))
			expect(row).toBeDefined()
			expect(row.type).toBe('knowledge')
			expect(row.metadata).toMatchObject({
				source: 'workspace_onboarding',
				prompt_key: 'product_vision',
				subject_kind: 'workspace_owner',
				subject_id: ownerActorId,
			})

			const edges = await db
				.select()
				.from(relationships)
				.where(eq(relationships.sourceId, knowledgeId))
			const aboutEdge = edges.find((e) => e.type === 'about')
			expect(aboutEdge).toBeDefined()
			expect(aboutEdge?.targetId).toBe(ownerActorId)
			const relatesEdge = edges.find((e) => e.type === 'relates_to')
			expect(relatesEdge).toBeDefined()
			expect(relatesEdge?.targetId).toBe(session.id)
		})

		it('routes the `about` edge to the workspace for the north_star_metric prompt', async () => {
			const app = createApp()
			const session = await insertObject(db, workspaceId, ownerActorId, {
				type: 'onboarding_session',
				title: 'Getting your workspace ready',
				status: 'active',
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
								title: 'North Star metric',
								status: 'validated',
								content: 'Weekly active workspaces with at least one closed bet.',
								metadata: {
									source: 'workspace_onboarding',
									prompt_key: 'north_star_metric',
									subject_kind: 'workspace',
									subject_id: workspaceId,
									claim: 'NSM: weekly active workspaces with a closed bet.',
									confidence: 'medium',
									valid_from: new Date().toISOString(),
									valid_to: null,
								},
							},
						],
						edges: [
							{ source: 'k1', target: workspaceId, type: 'about' },
							{ source: 'k1', target: session.id, type: 'relates_to' },
						],
					},
					{ 'x-workspace-id': workspaceId },
				),
			)

			expect(res.status).toBe(201)
			const knowledgeId = (await res.json()).nodes[0].id

			const aboutEdges = await db
				.select()
				.from(relationships)
				.where(and(eq(relationships.sourceId, knowledgeId), eq(relationships.type, 'about')))
			expect(aboutEdges).toHaveLength(1)
			expect(aboutEdges[0].targetId).toBe(workspaceId)
		})
	})

	describe('backfill migration — bare knowledge rows get their `about` edge', () => {
		it('leaves zero owner-targeted onboarding rows without `about → actor`, routes NSM to workspace, and preserves existing metadata keys', async () => {
			// Seed the pre-migration state: a distinct owner + the T4-shaped
			// onboarding_session + bare knowledge rows for the five prompts,
			// each linked back to the session via `relates_to` (the only
			// pre-flip signal we have to identify onboarding-authored rows).
			const owner = await insertActor(db, {
				type: 'human',
				name: 'Backfill Owner',
				email: 'backfill-owner@test.com',
			})
			const ws = await insertWorkspace(db, owner.id, {
				settings: KNOWLEDGE_WORKSPACE_SETTINGS,
			})
			const session = await insertObject(db, ws.id, owner.id, {
				type: 'onboarding_session',
				title: 'Getting your workspace ready',
				status: 'active',
			})
			// Seed workspace_onboarding_prompts rows so we can verify object_id
			// backfill on the (workspace, prompt_type) side too.
			await db
				.insert(workspaceOnboardingPrompts)
				.values(
					(
						[
							'product_vision',
							'icp',
							'first_bet_hypothesis',
							'north_star_metric',
							'customer_evidence',
						] as const
					).map((promptType) => ({ workspaceId: ws.id, promptType })),
				)
				.onConflictDoNothing()

			const promptRows: Record<string, string> = {}
			for (const title of [
				'Product vision',
				'ICP',
				'First-bet hypothesis',
				'North Star metric',
				'Customer evidence',
			]) {
				// One bare knowledge row per prompt with EXISTING metadata that
				// must survive the merge (asserts the `||` jsonb merge preserves
				// unrelated keys).
				const k = await insertObject(db, ws.id, owner.id, {
					type: 'knowledge',
					title,
					status: 'validated',
					metadata: { tags: ['onboarding'] },
				})
				promptRows[title] = k.id
				await insertRelationship(db, owner.id, {
					sourceType: 'object',
					sourceId: k.id,
					targetType: 'object',
					targetId: session.id,
					type: 'relates_to',
				})
			}

			// Also seed a non-onboarding knowledge row (no relates_to →
			// onboarding_session) — the backfill must ignore it. Title has to
			// be unique within the workspace (see
			// objects_ws_knowledge_title_unique_idx), so we use a distinct
			// wording that does not overlap the five onboarding prompt titles.
			const unrelated = await insertObject(db, ws.id, owner.id, {
				type: 'knowledge',
				title: 'Deployment runbook',
				status: 'validated',
			})

			await runBackfill()

			const ownerTargeted: Array<{ title: string; prompt: string }> = [
				{ title: 'Product vision', prompt: 'product_vision' },
				{ title: 'ICP', prompt: 'icp' },
				{ title: 'First-bet hypothesis', prompt: 'first_bet_hypothesis' },
				{ title: 'Customer evidence', prompt: 'customer_evidence' },
			]
			for (const { title, prompt } of ownerTargeted) {
				const knowledgeId = promptRows[title]
				const edges = await db
					.select()
					.from(relationships)
					.where(and(eq(relationships.sourceId, knowledgeId), eq(relationships.type, 'about')))
				expect(edges).toHaveLength(1)
				expect(edges[0].targetId).toBe(owner.id)

				const [row] = await db.select().from(objects).where(eq(objects.id, knowledgeId))
				expect(row.metadata).toMatchObject({
					source: 'workspace_onboarding',
					prompt_key: prompt,
					subject_kind: 'workspace_owner',
					subject_id: owner.id,
					tags: ['onboarding'],
				})
			}

			const nsmId = promptRows['North Star metric']
			const nsmEdges = await db
				.select()
				.from(relationships)
				.where(and(eq(relationships.sourceId, nsmId), eq(relationships.type, 'about')))
			expect(nsmEdges).toHaveLength(1)
			expect(nsmEdges[0].targetId).toBe(ws.id)
			const [nsmRow] = await db.select().from(objects).where(eq(objects.id, nsmId))
			expect(nsmRow.metadata).toMatchObject({
				source: 'workspace_onboarding',
				prompt_key: 'north_star_metric',
				subject_kind: 'workspace',
				subject_id: ws.id,
			})

			// Unrelated knowledge row untouched — no about edge, no metadata
			// stamp.
			const unrelatedEdges = await db
				.select()
				.from(relationships)
				.where(and(eq(relationships.sourceId, unrelated.id), eq(relationships.type, 'about')))
			expect(unrelatedEdges).toHaveLength(0)

			// workspace_onboarding_prompts.object_id populated.
			const prompts = await db
				.select()
				.from(workspaceOnboardingPrompts)
				.where(eq(workspaceOnboardingPrompts.workspaceId, ws.id))
			const byType = new Map(prompts.map((p) => [p.promptType, p.objectId]))
			expect(byType.get('product_vision')).toBe(promptRows['Product vision'])
			expect(byType.get('icp')).toBe(promptRows.ICP)
			expect(byType.get('first_bet_hypothesis')).toBe(promptRows['First-bet hypothesis'])
			expect(byType.get('north_star_metric')).toBe(promptRows['North Star metric'])
			expect(byType.get('customer_evidence')).toBe(promptRows['Customer evidence'])

			// Idempotent: a second run does not create duplicate about edges
			// or otherwise mutate state.
			await runBackfill()
			for (const { title } of ownerTargeted) {
				const edges = await db
					.select()
					.from(relationships)
					.where(
						and(eq(relationships.sourceId, promptRows[title]), eq(relationships.type, 'about')),
					)
				expect(edges).toHaveLength(1)
			}
		})
	})
})
