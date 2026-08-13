import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import reviewerVerdictsRoutes from '../../routes/reviewer-verdicts'
import { jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

const WORKSPACE_ID = randomUUID()
const HEADERS = { 'X-Workspace-Id': WORKSPACE_ID }

function makeVerdictBody(overrides: Record<string, unknown> = {}) {
	return {
		rubric_id: randomUUID(),
		actor_id: randomUUID(),
		reviewer_actor_id: randomUUID(),
		verdict: 'pass' as const,
		criteria_verdicts: [
			{ name: 'persona_specificity', pass: true },
			{ name: 'no_hedging', pass: true },
		],
		...overrides,
	}
}

describe('POST /reviewer-verdicts', () => {
	it('rejects missing workspace header with 400', async () => {
		const { app } = createTestApp(reviewerVerdictsRoutes, '/api/reviewer-verdicts')
		const res = await app.request(jsonRequest('POST', '/api/reviewer-verdicts', makeVerdictBody()))
		expect(res.status).toBe(400)
	})

	it('rejects non-uuid workspace header with 400', async () => {
		const { app } = createTestApp(reviewerVerdictsRoutes, '/api/reviewer-verdicts')
		const res = await app.request(
			jsonRequest('POST', '/api/reviewer-verdicts', makeVerdictBody(), {
				'X-Workspace-Id': 'not-a-uuid',
			}),
		)
		expect(res.status).toBe(400)
	})

	it('rejects invalid body with 400 and structured error', async () => {
		const { app } = createTestApp(reviewerVerdictsRoutes, '/api/reviewer-verdicts')
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/reviewer-verdicts',
				{ rubric_id: 'not-a-uuid', verdict: 'maybe' },
				HEADERS,
			),
		)
		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error.code).toBe('VALIDATION_ERROR')
	})

	it('returns 404 when rubric object not found in workspace', async () => {
		const { app, mockResults } = createTestApp(reviewerVerdictsRoutes, '/api/reviewer-verdicts')
		// service does: rubric lookup (empty), then would look up target
		mockResults.selectQueue = [[]]
		const res = await app.request(
			jsonRequest('POST', '/api/reviewer-verdicts', makeVerdictBody(), HEADERS),
		)
		expect(res.status).toBe(404)
	})

	it('returns 201 with id and null human_agreed on happy path', async () => {
		const { app, mockResults, calls } = createTestApp(
			reviewerVerdictsRoutes,
			'/api/reviewer-verdicts',
		)
		const rubricId = randomUUID()
		const targetActorId = randomUUID()
		const newVerdictId = randomUUID()
		mockResults.selectQueue = [
			[{ id: rubricId }], // rubric lookup
			[{ id: targetActorId }], // target actor lookup
		]
		mockResults.insertQueue = [
			[
				{
					id: newVerdictId,
					cycleNumber: 0,
				},
			],
			[], // events insert
		]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/reviewer-verdicts',
				makeVerdictBody({
					rubric_id: rubricId,
					actor_id: targetActorId,
				}),
				HEADERS,
			),
		)
		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body).toMatchObject({ id: newVerdictId, human_agreed: null })
		// The route captured a values() call for the verdict insert AND for the audit event insert.
		expect(calls.inserts.length).toBeGreaterThanOrEqual(2)
	})
})

describe('PATCH /reviewer-verdicts/:id', () => {
	it('rejects missing workspace header with 400', async () => {
		const { app } = createTestApp(reviewerVerdictsRoutes, '/api/reviewer-verdicts')
		const res = await app.request(
			jsonRequest('PATCH', `/api/reviewer-verdicts/${randomUUID()}`, { human_agreed: true }),
		)
		expect(res.status).toBe(400)
	})

	it('returns 404 when verdict not found', async () => {
		const { app, mockResults } = createTestApp(reviewerVerdictsRoutes, '/api/reviewer-verdicts')
		mockResults.selectQueue = [[]]
		const res = await app.request(
			jsonRequest(
				'PATCH',
				`/api/reviewer-verdicts/${randomUUID()}`,
				{ human_agreed: true },
				HEADERS,
			),
		)
		expect(res.status).toBe(404)
	})

	it('returns 409 when verdict already rated', async () => {
		const { app, mockResults } = createTestApp(reviewerVerdictsRoutes, '/api/reviewer-verdicts')
		const verdictId = randomUUID()
		mockResults.selectQueue = [
			[
				{
					id: verdictId,
					workspaceId: WORKSPACE_ID,
					reviewerActorId: randomUUID(),
					rubricId: randomUUID(),
					targetActorId: randomUUID(),
					humanAgreed: true,
				},
			],
		]
		const res = await app.request(
			jsonRequest('PATCH', `/api/reviewer-verdicts/${verdictId}`, { human_agreed: false }, HEADERS),
		)
		expect(res.status).toBe(409)
	})

	it('returns 403 when the reviewer tries to rate its own verdict', async () => {
		const { app, mockResults } = createTestApp(reviewerVerdictsRoutes, '/api/reviewer-verdicts')
		const verdictId = randomUUID()
		mockResults.selectQueue = [
			[
				{
					id: verdictId,
					workspaceId: WORKSPACE_ID,
					reviewerActorId: 'test-actor-id', // === createTestApp default actorId
					rubricId: randomUUID(),
					targetActorId: randomUUID(),
					humanAgreed: null,
				},
			],
		]
		const res = await app.request(
			jsonRequest('PATCH', `/api/reviewer-verdicts/${verdictId}`, { human_agreed: true }, HEADERS),
		)
		expect(res.status).toBe(403)
	})

	it('returns updated payload on happy path', async () => {
		const { app, mockResults, calls } = createTestApp(
			reviewerVerdictsRoutes,
			'/api/reviewer-verdicts',
		)
		const verdictId = randomUUID()
		mockResults.selectQueue = [
			[
				{
					id: verdictId,
					workspaceId: WORKSPACE_ID,
					reviewerActorId: randomUUID(), // different from test-actor-id
					rubricId: randomUUID(),
					targetActorId: randomUUID(),
					humanAgreed: null,
				},
			],
		]
		mockResults.updateQueue = [
			[
				{
					id: verdictId,
					humanAgreed: false,
					humanCriteriaDisagreements: ['no_hedging'],
				},
			],
		]

		const res = await app.request(
			jsonRequest(
				'PATCH',
				`/api/reviewer-verdicts/${verdictId}`,
				{
					human_agreed: false,
					criteria_disagreements: ['no_hedging'],
					note: 'reviewer accepted a hedged response',
				},
				HEADERS,
			),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({
			id: verdictId,
			human_agreed: false,
			human_criteria_disagreements: ['no_hedging'],
		})
		// One update call (the rating) + one insert call (the audit event).
		expect(calls.updates.length).toBe(1)
		expect(calls.inserts.length).toBe(1)
	})
})

describe('GET /reviewer-verdicts/summary', () => {
	it('rejects missing rubric_id query with 400', async () => {
		const { app } = createTestApp(reviewerVerdictsRoutes, '/api/reviewer-verdicts')
		const res = await app.request(jsonGet('/api/reviewer-verdicts/summary', HEADERS))
		expect(res.status).toBe(400)
	})

	it('returns precision below threshold with failing_criteria named', async () => {
		const { app, mockResults } = createTestApp(reviewerVerdictsRoutes, '/api/reviewer-verdicts')
		const rubricId = randomUUID()
		// Service queries: (1) rated rows, then (2) total count.
		mockResults.selectQueue = [
			[
				{
					verdict: 'pass',
					humanAgreed: false,
					humanCriteriaDisagreements: ['no_hedging', 'persona_specificity'],
					criteriaVerdicts: [
						{ name: 'no_hedging', pass: true },
						{ name: 'persona_specificity', pass: true },
					],
				},
				{
					verdict: 'pass',
					humanAgreed: true,
					humanCriteriaDisagreements: null,
					criteriaVerdicts: [{ name: 'no_hedging', pass: true }],
				},
				{
					verdict: 'pass',
					humanAgreed: false,
					humanCriteriaDisagreements: ['no_hedging'],
					criteriaVerdicts: [{ name: 'no_hedging', pass: true }],
				},
			],
			[{ count: 3 }],
		]

		const res = await app.request(
			jsonGet(`/api/reviewer-verdicts/summary?rubric_id=${rubricId}`, HEADERS),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.rated_verdicts).toBe(3)
		expect(body.agreed_verdicts).toBe(1)
		expect(body.precision).toBeCloseTo(1 / 3, 5)
		expect(body.meets_threshold).toBe(false)
		expect(body.failing_criteria[0]).toEqual({
			name: 'no_hedging',
			false_positive_count: 2,
		})
		expect(body.summary_line).toContain('BELOW')
		expect(body.summary_line).toContain('no_hedging')
	})

	it('returns null precision when no rated verdicts exist yet', async () => {
		const { app, mockResults } = createTestApp(reviewerVerdictsRoutes, '/api/reviewer-verdicts')
		mockResults.selectQueue = [[], [{ count: 0 }]]
		const res = await app.request(
			jsonGet(`/api/reviewer-verdicts/summary?rubric_id=${randomUUID()}`, HEADERS),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.precision).toBeNull()
		expect(body.rated_verdicts).toBe(0)
		expect(body.meets_threshold).toBe(false)
	})
})
