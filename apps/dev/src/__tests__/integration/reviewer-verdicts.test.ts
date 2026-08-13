import { OpenAPIHono } from '@hono/zod-openapi'
import { events, reviewerVerdicts } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, desc, eq } from 'drizzle-orm'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: reviewerVerdictsRoutes } = await import('../../routes/reviewer-verdicts')

function createApp(overrideActorId?: string) {
	// createIntegrationApp defaults to the test actor. When we need a different
	// caller (e.g. to simulate a reviewer bot vs. a human rater), rebuild the app
	// with a fresh middleware that sets the desired actorId.
	if (!overrideActorId) {
		return createIntegrationApp({ path: '/api/reviewer-verdicts', module: reviewerVerdictsRoutes })
	}
	const app = new OpenAPIHono()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', overrideActorId)
		c.set('actorType', 'agent')
		c.set('notifyBridge', {} as PgNotifyBridge)
		await next()
	})
	app.route('/api/reviewer-verdicts', reviewerVerdictsRoutes)
	return app
}

describe('Reviewer Verdicts Integration — persist / rate / precision', () => {
	let workspaceId: string
	let rubricId: string
	let targetActorId: string
	let reviewerActorId: string
	let humanRaterId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const rubric = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'rubric',
			title: 'Stage 2 reviewer rubric',
			status: 'active',
		})
		rubricId = rubric.id
		const target = await insertActor(db, { type: 'agent', name: 'Target SME Agent' })
		targetActorId = target.id
		const reviewer = await insertActor(db, { type: 'agent', name: 'Fresh-Context Reviewer' })
		reviewerActorId = reviewer.id
		const human = await insertActor(db, { type: 'human', name: 'Human Rater' })
		humanRaterId = human.id
	})

	it('POST creates a row, fires an audit event, and returns id with null human_agreed', async () => {
		const app = createApp()
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/reviewer-verdicts',
				{
					rubric_id: rubricId,
					actor_id: targetActorId,
					reviewer_actor_id: reviewerActorId,
					cycle_number: 1,
					verdict: 'fail',
					criteria_verdicts: [
						{ name: 'persona_specificity', pass: true },
						{ name: 'no_hedging', pass: false, fix: 'Add a Recommendation: line.' },
					],
				},
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.id).toBeTruthy()
		expect(body.human_agreed).toBeNull()

		const [row] = await db
			.select()
			.from(reviewerVerdicts)
			.where(eq(reviewerVerdicts.id, body.id))
			.limit(1)
		expect(row.verdict).toBe('fail')
		expect(row.humanAgreed).toBeNull()
		expect(row.cycleNumber).toBe(1)
		expect(Array.isArray(row.criteriaVerdicts)).toBe(true)

		const [ev] = await db
			.select()
			.from(events)
			.where(and(eq(events.entityType, 'reviewer_verdict'), eq(events.entityId, body.id)))
			.limit(1)
		expect(ev.action).toBe('created')
	})

	it('POST rejects a rubric_id that does not belong to the workspace', async () => {
		const otherWs = await insertWorkspace(db, getTestActorId())
		const otherRubric = await insertObject(db, otherWs.id, getTestActorId(), {
			type: 'rubric',
			status: 'active',
		})
		const app = createApp()
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/reviewer-verdicts',
				{
					rubric_id: otherRubric.id,
					actor_id: targetActorId,
					reviewer_actor_id: reviewerActorId,
					verdict: 'pass',
					criteria_verdicts: [{ name: 'no_hedging', pass: true }],
				},
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		expect(res.status).toBe(404)
	})

	it('PATCH sets human_agreed, records the rater, and blocks a second rating', async () => {
		const reviewerApp = createApp(reviewerActorId)
		const created = await reviewerApp.request(
			jsonRequest(
				'POST',
				'/api/reviewer-verdicts',
				{
					rubric_id: rubricId,
					actor_id: targetActorId,
					reviewer_actor_id: reviewerActorId,
					verdict: 'pass',
					criteria_verdicts: [{ name: 'no_hedging', pass: true }],
				},
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		const { id: verdictId } = await created.json()

		const humanApp = createApp(humanRaterId)
		const rated = await humanApp.request(
			jsonRequest(
				'PATCH',
				`/api/reviewer-verdicts/${verdictId}`,
				{ human_agreed: true },
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		expect(rated.status).toBe(200)
		const ratedBody = await rated.json()
		expect(ratedBody.human_agreed).toBe(true)

		const [row] = await db
			.select()
			.from(reviewerVerdicts)
			.where(eq(reviewerVerdicts.id, verdictId))
			.limit(1)
		expect(row.humanRatedBy).toBe(humanRaterId)
		expect(row.humanRatedAt).toBeInstanceOf(Date)

		// A second rating is refused so a human's original judgment is never
		// silently overwritten.
		const second = await humanApp.request(
			jsonRequest(
				'PATCH',
				`/api/reviewer-verdicts/${verdictId}`,
				{ human_agreed: false },
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		expect(second.status).toBe(409)
	})

	it('PATCH forbids the reviewer from rating its own verdict (403)', async () => {
		const reviewerApp = createApp(reviewerActorId)
		const created = await reviewerApp.request(
			jsonRequest(
				'POST',
				'/api/reviewer-verdicts',
				{
					rubric_id: rubricId,
					actor_id: targetActorId,
					reviewer_actor_id: reviewerActorId,
					verdict: 'pass',
					criteria_verdicts: [{ name: 'no_hedging', pass: true }],
				},
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		const { id: verdictId } = await created.json()

		const selfRate = await reviewerApp.request(
			jsonRequest(
				'PATCH',
				`/api/reviewer-verdicts/${verdictId}`,
				{ human_agreed: true },
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		expect(selfRate.status).toBe(403)
	})

	it('GET summary returns precision + failing_criteria across ≥10 rated verdicts', async () => {
		const reviewerApp = createApp(reviewerActorId)
		const humanApp = createApp(humanRaterId)

		// 10 verdicts total: 6 the human agrees with, 4 they flag as false positives
		// with per-criterion detail. Precision = 6/10 = 0.6 → below the 0.7 gate.
		const ratings: Array<{ agree: boolean; disagreements?: string[] }> = [
			{ agree: true },
			{ agree: true },
			{ agree: true },
			{ agree: true },
			{ agree: true },
			{ agree: true },
			{ agree: false, disagreements: ['no_hedging'] },
			{ agree: false, disagreements: ['no_hedging', 'persona_specificity'] },
			{ agree: false, disagreements: ['no_hedging'] },
			{ agree: false, disagreements: ['scope_boundaries'] },
		]

		for (const { agree, disagreements } of ratings) {
			const created = await reviewerApp.request(
				jsonRequest(
					'POST',
					'/api/reviewer-verdicts',
					{
						rubric_id: rubricId,
						actor_id: targetActorId,
						reviewer_actor_id: reviewerActorId,
						verdict: 'pass',
						criteria_verdicts: [
							{ name: 'no_hedging', pass: true },
							{ name: 'persona_specificity', pass: true },
							{ name: 'scope_boundaries', pass: true },
						],
					},
					{ 'X-Workspace-Id': workspaceId },
				),
			)
			const { id } = await created.json()
			const rateBody: Record<string, unknown> = { human_agreed: agree }
			if (disagreements) rateBody.criteria_disagreements = disagreements
			const rated = await humanApp.request(
				jsonRequest('PATCH', `/api/reviewer-verdicts/${id}`, rateBody, {
					'X-Workspace-Id': workspaceId,
				}),
			)
			expect(rated.status).toBe(200)
		}

		const summaryRes = await humanApp.request(
			jsonGet(`/api/reviewer-verdicts/summary?rubric_id=${rubricId}`, {
				'X-Workspace-Id': workspaceId,
			}),
		)
		expect(summaryRes.status).toBe(200)
		const summary = await summaryRes.json()
		expect(summary.total_verdicts).toBe(10)
		expect(summary.rated_verdicts).toBe(10)
		expect(summary.agreed_verdicts).toBe(6)
		expect(summary.precision).toBeCloseTo(0.6, 5)
		expect(summary.meets_threshold).toBe(false)
		// no_hedging shows up in 3 disagreements, persona_specificity in 1,
		// scope_boundaries in 1 — sorted descending.
		expect(summary.failing_criteria[0]).toEqual({
			name: 'no_hedging',
			false_positive_count: 3,
		})
		expect(summary.summary_line).toContain('60.0%')
		expect(summary.summary_line).toContain('no_hedging')
	})

	it('rating pair check constraint: cannot land a partial rating via direct DB write', async () => {
		// Belt-and-suspenders for the DB CHECK constraint documented in the
		// migration — if the route layer ever drifts, the DB refuses the row.
		const reviewerApp = createApp(reviewerActorId)
		const created = await reviewerApp.request(
			jsonRequest(
				'POST',
				'/api/reviewer-verdicts',
				{
					rubric_id: rubricId,
					actor_id: targetActorId,
					reviewer_actor_id: reviewerActorId,
					verdict: 'pass',
					criteria_verdicts: [{ name: 'no_hedging', pass: true }],
				},
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		const { id } = await created.json()
		await expect(
			db
				.update(reviewerVerdicts)
				.set({ humanAgreed: true, humanRatedBy: null, humanRatedAt: null })
				.where(eq(reviewerVerdicts.id, id)),
		).rejects.toThrow()
	})

	it('newest verdict per rubric wins on tie via createdAt DESC ordering', async () => {
		// Sanity check for the summary's implicit ordering when we later add
		// per-verdict inspection surfaces.
		const reviewerApp = createApp(reviewerActorId)
		const first = await reviewerApp.request(
			jsonRequest(
				'POST',
				'/api/reviewer-verdicts',
				{
					rubric_id: rubricId,
					actor_id: targetActorId,
					reviewer_actor_id: reviewerActorId,
					verdict: 'pass',
					criteria_verdicts: [{ name: 'no_hedging', pass: true }],
				},
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		await first.json()
		const second = await reviewerApp.request(
			jsonRequest(
				'POST',
				'/api/reviewer-verdicts',
				{
					rubric_id: rubricId,
					actor_id: targetActorId,
					reviewer_actor_id: reviewerActorId,
					verdict: 'fail',
					criteria_verdicts: [{ name: 'no_hedging', pass: false }],
				},
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		const { id: secondId } = await second.json()

		const rows = await db
			.select()
			.from(reviewerVerdicts)
			.where(eq(reviewerVerdicts.rubricId, rubricId))
			.orderBy(desc(reviewerVerdicts.createdAt))
		expect(rows[0].id).toBe(secondId)
	})
})
