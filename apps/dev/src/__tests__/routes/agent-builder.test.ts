import type { OpenAPIHono } from '@hono/zod-openapi'
import { OpenAPIHono as CreateOpenAPIHono } from '@hono/zod-openapi'
import type { PgNotifyBridge } from '@maskin/realtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import agentBuilderRoutes from '../../routes/agent-builder'
import { jsonRequest } from '../helpers'
import { createMockAgentStorage, createMockSessionManager, createTestContext } from '../setup'

vi.mock('../../services/agent-builder', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../services/agent-builder')>()
	return {
		...actual,
		reviewerVerdictWorkflow: vi.fn(),
		refineAgent: vi.fn(),
	}
})

vi.mock('../../services/agent-builder-bootstrap', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../services/agent-builder-bootstrap')>()
	return {
		...actual,
		getOrBootstrapAgentBuilderActor: vi.fn(),
	}
})

const service = await import('../../services/agent-builder')
const reviewerVerdictWorkflow = service.reviewerVerdictWorkflow as unknown as ReturnType<
	typeof vi.fn
>
const refineAgent = service.refineAgent as unknown as ReturnType<typeof vi.fn>

const bootstrapService = await import('../../services/agent-builder-bootstrap')
const getOrBootstrapAgentBuilderActor =
	bootstrapService.getOrBootstrapAgentBuilderActor as unknown as ReturnType<typeof vi.fn>

const BASE = '/api/agent-builder'
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111'
const OBJECT_ID = '77777777-7777-7777-7777-777777777777'
const SESSION_ID = '88888888-8888-8888-8888-888888888888'
const ACTOR_ID = '33333333-3333-3333-3333-333333333333'
const RUBRIC_ID = '55555555-5555-5555-5555-555555555555'
const BUILDER_ACTOR_ID = '66666666-6666-6666-6666-666666666666'

function createAgentBuilderTestApp() {
	const app = new CreateOpenAPIHono()
	const { db, mockResults } = createTestContext()
	// Routes now check isWorkspaceMember(db, actorId, workspaceId) before
	// dispatching (see the body-workspace_id auth-bypass fix) — the service
	// functions below are mocked out entirely, so this membership row is the
	// only thing the mock db.select() needs to serve for the happy paths.
	mockResults.select = [{ actorId: 'caller-actor-id' }]
	const agentStorage = createMockAgentStorage()
	const sessionManager = createMockSessionManager()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', 'caller-actor-id')
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('agentStorage', agentStorage)
		c.set('sessionManager', sessionManager)
		await next()
	})
	app.route(BASE, agentBuilderRoutes as unknown as OpenAPIHono)
	return { app, db, mockResults, agentStorage, sessionManager }
}

describe('POST /api/agent-builder/create', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined)
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
		getOrBootstrapAgentBuilderActor.mockResolvedValue({
			actorId: BUILDER_ACTOR_ID,
			bootstrapped: false,
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
		getOrBootstrapAgentBuilderActor.mockReset()
	})

	it('returns 202 with session_id + status immediately, without waiting for the pipeline', async () => {
		const { app, sessionManager } = createAgentBuilderTestApp()
		;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: 'session-1',
			status: 'pending',
		})

		const res = await app.request(
			jsonRequest('POST', `${BASE}/create`, {
				prompt: 'help plan a B2B launch',
				workspace_id: WORKSPACE_ID,
			}),
		)

		expect(res.status).toBe(202)
		const body = await res.json()
		expect(body.session_id).toBe('session-1')
		expect(body.status).toBe('pending')
		expect(sessionManager.createSession).toHaveBeenCalledWith(
			WORKSPACE_ID,
			expect.objectContaining({
				actorId: BUILDER_ACTOR_ID,
				createdBy: 'caller-actor-id',
				autoStart: true,
				actionPrompt: expect.stringContaining('help plan a B2B launch'),
			}),
		)
	})

	it('accepts workspace_id via X-Workspace-Id header', async () => {
		const { app, sessionManager } = createAgentBuilderTestApp()
		;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: 'session-2',
			status: 'pending',
		})

		const req = new Request(`http://localhost${BASE}/create`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Workspace-Id': WORKSPACE_ID,
			},
			body: JSON.stringify({ prompt: 'plan a launch' }),
		})
		const res = await app.request(req)
		expect(res.status).toBe(202)
	})

	it('returns 400 when body is missing prompt', async () => {
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/create`, { workspace_id: WORKSPACE_ID }),
		)
		expect(res.status).toBe(400)
	})

	it('returns 400 when body is not JSON', async () => {
		const { app } = createAgentBuilderTestApp()
		const req = new Request(`http://localhost${BASE}/create`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: 'not-json',
		})
		const res = await app.request(req)
		expect(res.status).toBe(400)
	})

	it('returns 400 when workspace_id is missing from body AND header', async () => {
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/create`, { prompt: 'plan something' }),
		)
		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error?.message ?? body.message).toMatch(/workspace_id/i)
	})

	it('returns 400 when workspace_id is not a valid UUID', async () => {
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/create`, {
				prompt: 'plan something',
				workspace_id: 'not-a-uuid',
			}),
		)
		expect(res.status).toBe(400)
	})

	it('returns 500 when starting the session fails', async () => {
		const { app, sessionManager } = createAgentBuilderTestApp()
		;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
		const res = await app.request(
			jsonRequest('POST', `${BASE}/create`, {
				prompt: 'anything',
				workspace_id: WORKSPACE_ID,
			}),
		)
		expect(res.status).toBe(500)
	})

	it('returns 404 and never bootstraps or dispatches when the caller is not a member of the body-supplied workspace_id', async () => {
		const { app, mockResults } = createAgentBuilderTestApp()
		// No membership row for this actor/workspace pair — simulates a caller
		// with a valid API key for a different workspace supplying an arbitrary
		// workspace_id in the body instead of the (membership-checked) header.
		mockResults.select = []

		const res = await app.request(
			jsonRequest('POST', `${BASE}/create`, {
				prompt: 'help plan a B2B launch',
				workspace_id: WORKSPACE_ID,
			}),
		)

		expect(res.status).toBe(404)
		expect(getOrBootstrapAgentBuilderActor).not.toHaveBeenCalled()
	})
})

describe('POST /api/agent-builder/reviewer-verdict', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined)
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})
	afterEach(() => {
		vi.restoreAllMocks()
		reviewerVerdictWorkflow.mockReset()
	})

	it('returns 200 with the structured verdict for an object_id review (unpersisted — no target actor)', async () => {
		reviewerVerdictWorkflow.mockResolvedValue({
			review: {
				verdict: {
					overall: 'pass',
					criteria: [{ name: 'persona_specificity', pass: true, fix: '' }],
				},
				reviewerSessionId: 'rev-session-uuid',
				rubricId: RUBRIC_ID,
				targetActorId: null,
				verdictId: null,
				persisted: false,
				persistenceNote: 'verdict computed but not persisted — no target actor',
			},
			rating: null,
			precisionSummary: null,
		})

		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/reviewer-verdict`, {
				object_id: OBJECT_ID,
				workspace_id: WORKSPACE_ID,
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.verdict.overall).toBe('pass')
		expect(body.verdict.rubric_id).toBe(RUBRIC_ID)
		expect(body.verdict.reviewer_session_id).toBe('rev-session-uuid')
		expect(body.verdict.criteria[0].name).toBe('persona_specificity')
		expect(body.verdict.persisted).toBe(false)
		expect(body.verdict.verdict_id).toBeNull()
		expect(body.rating).toBeNull()
		expect(body.precision_summary).toBeNull()
	})

	it('returns 200 with a persisted, ratable verdict for a session_id review', async () => {
		reviewerVerdictWorkflow.mockResolvedValue({
			review: {
				verdict: {
					overall: 'fail',
					criteria: [
						{ name: 'persona_specificity', pass: true, fix: '' },
						{ name: 'no_hedging_enforcement', pass: false, fix: 'Add anti-hedging directive.' },
					],
				},
				reviewerSessionId: 'rev-session-uuid',
				rubricId: RUBRIC_ID,
				targetActorId: ACTOR_ID,
				verdictId: 'verdict-uuid',
				persisted: true,
			},
			rating: null,
			precisionSummary: {
				rubric_id: RUBRIC_ID,
				precision_threshold: 0.7,
				total_verdicts: 1,
				rated_verdicts: 0,
				agreed_verdicts: 0,
				precision: null,
				meets_threshold: false,
				failing_criteria: [],
				summary_line: `Reviewer precision: no rated verdicts yet for rubric ${RUBRIC_ID} (1 total unrated).`,
			},
		})

		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/reviewer-verdict`, {
				session_id: SESSION_ID,
				workspace_id: WORKSPACE_ID,
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.verdict.overall).toBe('fail')
		expect(body.verdict.target_actor_id).toBe(ACTOR_ID)
		expect(body.verdict.persisted).toBe(true)
		expect(body.verdict.verdict_id).toBe('verdict-uuid')
		expect(body.verdict.criteria[1].pass).toBe(false)
		expect(body.precision_summary.total_verdicts).toBe(1)
	})

	it('returns 200 with rating + precision_summary for a rate-only call (no review)', async () => {
		reviewerVerdictWorkflow.mockResolvedValue({
			review: null,
			rating: { verdictId: 'verdict-uuid', humanAgreed: true, humanCriteriaDisagreements: null },
			precisionSummary: {
				rubric_id: RUBRIC_ID,
				precision_threshold: 0.7,
				total_verdicts: 3,
				rated_verdicts: 1,
				agreed_verdicts: 1,
				precision: 1,
				meets_threshold: true,
				failing_criteria: [],
				summary_line: 'Reviewer precision 100.0% (1/1) — meets ≥70% gate.',
			},
		})

		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/reviewer-verdict`, {
				verdict_id: 'verdict-uuid',
				human_agreed: true,
				workspace_id: WORKSPACE_ID,
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.verdict).toBeNull()
		expect(body.rating.verdict_id).toBe('verdict-uuid')
		expect(body.rating.human_agreed).toBe(true)
		expect(body.precision_summary.meets_threshold).toBe(true)
	})

	it('returns 400 when both object_id and session_id are provided', async () => {
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/reviewer-verdict`, {
				object_id: OBJECT_ID,
				session_id: SESSION_ID,
				workspace_id: WORKSPACE_ID,
			}),
		)
		expect(res.status).toBe(400)
	})

	it('returns 400 when the service rejects because no target was specified', async () => {
		const { AgentReviewTargetError } = await import('../../services/agent-builder')
		reviewerVerdictWorkflow.mockRejectedValue(
			new AgentReviewTargetError(
				'no_target_specified',
				'Provide at least one of object_id, session_id, verdict_id, or rubric_id.',
			),
		)
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/reviewer-verdict`, { workspace_id: WORKSPACE_ID }),
		)
		expect(res.status).toBe(400)
	})

	it('returns 400 when human_agreed is provided with no ratable verdict available', async () => {
		const { AgentReviewTargetError } = await import('../../services/agent-builder')
		reviewerVerdictWorkflow.mockRejectedValue(
			new AgentReviewTargetError('no_verdict_to_rate', 'human_agreed was provided but no verdict'),
		)
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/reviewer-verdict`, {
				rubric_id: RUBRIC_ID,
				human_agreed: true,
				workspace_id: WORKSPACE_ID,
			}),
		)
		expect(res.status).toBe(400)
	})

	it('returns 400 when workspace_id is missing', async () => {
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/reviewer-verdict`, { object_id: OBJECT_ID }),
		)
		expect(res.status).toBe(400)
	})

	it('returns 404 when the reviewer target is not found', async () => {
		const { AgentReviewTargetError } = await import('../../services/agent-builder')
		reviewerVerdictWorkflow.mockRejectedValue(
			new AgentReviewTargetError('target_not_found', 'Object not found'),
		)
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/reviewer-verdict`, {
				object_id: OBJECT_ID,
				workspace_id: WORKSPACE_ID,
			}),
		)
		expect(res.status).toBe(404)
	})

	it('returns 400 when target_actor_id does not resolve to a real actor', async () => {
		const { ReviewerVerdictError } = await import('../../services/reviewer-verdicts')
		reviewerVerdictWorkflow.mockRejectedValue(
			new ReviewerVerdictError('target_actor_not_found', 'Target actor not found'),
		)
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/reviewer-verdict`, {
				object_id: OBJECT_ID,
				target_actor_id: ACTOR_ID,
				workspace_id: WORKSPACE_ID,
			}),
		)
		expect(res.status).toBe(400)
	})

	it('returns 409 when rating an already-rated verdict', async () => {
		const { ReviewerVerdictError } = await import('../../services/reviewer-verdicts')
		reviewerVerdictWorkflow.mockRejectedValue(
			new ReviewerVerdictError('already_rated', 'Reviewer verdict already rated'),
		)
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/reviewer-verdict`, {
				verdict_id: 'verdict-uuid',
				human_agreed: true,
				workspace_id: WORKSPACE_ID,
			}),
		)
		expect(res.status).toBe(409)
	})

	it('returns 403 when the reviewer tries to rate its own verdict', async () => {
		const { ReviewerVerdictError } = await import('../../services/reviewer-verdicts')
		reviewerVerdictWorkflow.mockRejectedValue(
			new ReviewerVerdictError('self_rating_forbidden', 'Reviewer cannot rate its own verdict'),
		)
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/reviewer-verdict`, {
				object_id: OBJECT_ID,
				target_actor_id: ACTOR_ID,
				human_agreed: true,
				workspace_id: WORKSPACE_ID,
			}),
		)
		expect(res.status).toBe(403)
	})

	it('returns 404 and never dispatches when the caller is not a member of the body-supplied workspace_id', async () => {
		const { app, mockResults } = createAgentBuilderTestApp()
		mockResults.select = []

		const res = await app.request(
			jsonRequest('POST', `${BASE}/reviewer-verdict`, {
				object_id: OBJECT_ID,
				workspace_id: WORKSPACE_ID,
			}),
		)

		expect(res.status).toBe(404)
		expect(reviewerVerdictWorkflow).not.toHaveBeenCalled()
	})
})

describe('POST /api/agent-builder/refine', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined)
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})
	afterEach(() => {
		vi.restoreAllMocks()
		refineAgent.mockReset()
	})

	it('returns 200 with updated_actor_id + diff on a successful refine', async () => {
		refineAgent.mockResolvedValue({
			updatedActorId: ACTOR_ID,
			diff: 'added sections: Response protocol; length changed by +12%',
			newSystemPrompt: '# updated agent\n\n## Background\n\nnew',
			previousSystemPrompt: '# old agent',
		})

		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/refine`, {
				actor_id: ACTOR_ID,
				context: 'sharpen the bias statement',
				workspace_id: WORKSPACE_ID,
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.updated_actor_id).toBe(ACTOR_ID)
		expect(body.diff).toMatch(/added sections/)
		expect(body.new_system_prompt).toMatch(/## Background/)
	})

	it("returns 404 when the actor is not in the caller's workspace", async () => {
		const { AgentRefineError } = await import('../../services/agent-builder')
		refineAgent.mockRejectedValue(
			new AgentRefineError('actor_wrong_workspace', 'Actor not in workspace'),
		)
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/refine`, {
				actor_id: ACTOR_ID,
				context: 'do a thing',
				workspace_id: WORKSPACE_ID,
			}),
		)
		expect(res.status).toBe(404)
	})

	it('returns 400 when context is missing', async () => {
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/refine`, {
				actor_id: ACTOR_ID,
				workspace_id: WORKSPACE_ID,
			}),
		)
		expect(res.status).toBe(400)
	})

	it('returns 400 when actor_id is not a valid UUID', async () => {
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/refine`, {
				actor_id: 'not-a-uuid',
				context: 'do a thing',
				workspace_id: WORKSPACE_ID,
			}),
		)
		expect(res.status).toBe(400)
	})

	it('returns 404 and never dispatches when the caller is not a member of the body-supplied workspace_id', async () => {
		const { app, mockResults } = createAgentBuilderTestApp()
		mockResults.select = []

		const res = await app.request(
			jsonRequest('POST', `${BASE}/refine`, {
				actor_id: ACTOR_ID,
				context: 'sharpen the bias statement',
				workspace_id: WORKSPACE_ID,
			}),
		)

		expect(res.status).toBe(404)
		expect(refineAgent).not.toHaveBeenCalled()
	})
})
