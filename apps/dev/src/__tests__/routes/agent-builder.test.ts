import type { OpenAPIHono } from '@hono/zod-openapi'
import { OpenAPIHono as CreateOpenAPIHono } from '@hono/zod-openapi'
import type { PgNotifyBridge } from '@maskin/realtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import agentBuilderRoutes from '../../routes/agent-builder'
import { jsonRequest } from '../helpers'
import { createMockAgentStorage, createTestContext } from '../setup'

vi.mock('../../services/agent-builder', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../services/agent-builder')>()
	return {
		...actual,
		runAgentBuilder: vi.fn(),
		reviewWork: vi.fn(),
		refineAgent: vi.fn(),
	}
})

const service = await import('../../services/agent-builder')
const runAgentBuilder = service.runAgentBuilder as unknown as ReturnType<typeof vi.fn>
const reviewWork = service.reviewWork as unknown as ReturnType<typeof vi.fn>
const refineAgent = service.refineAgent as unknown as ReturnType<typeof vi.fn>

const BASE = '/api/agent-builder'
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111'
const OBJECT_ID = '77777777-7777-7777-7777-777777777777'
const SESSION_ID = '88888888-8888-8888-8888-888888888888'
const ACTOR_ID = '33333333-3333-3333-3333-333333333333'
const RUBRIC_ID = '55555555-5555-5555-5555-555555555555'

function createAgentBuilderTestApp() {
	const app = new CreateOpenAPIHono()
	const { db, mockResults } = createTestContext()
	// Routes now check isWorkspaceMember(db, actorId, workspaceId) before
	// dispatching (see the body-workspace_id auth-bypass fix) — the service
	// functions below are mocked out entirely, so this membership row is the
	// only thing the mock db.select() needs to serve for the happy paths.
	mockResults.select = [{ actorId: 'caller-actor-id' }]
	const agentStorage = createMockAgentStorage()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', 'caller-actor-id')
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('agentStorage', agentStorage)
		await next()
	})
	app.route(BASE, agentBuilderRoutes as unknown as OpenAPIHono)
	return { app, db, mockResults, agentStorage }
}

describe('POST /api/agent-builder/create', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined)
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
		runAgentBuilder.mockReset()
	})

	function stubCreatedResult(overrides: Record<string, unknown> = {}) {
		runAgentBuilder.mockResolvedValue({
			kind: 'created',
			intent: {
				domain: 'growth',
				job_to_be_done: 'plan a launch',
				deliverables: [],
				constraints: [],
				is_underspecified: false,
				missing: [],
				gap_question: '',
			},
			persona: {
				name: 'Test',
				role: 'Growth PM',
				backstory: 'story',
				scope_boundaries: [],
				delegation_description: 'use when',
				tool_set: [],
			},
			systemPrompt: {} as never,
			opinionation: {} as never,
			assembledSystemPrompt: '# Test\n\n## Background\n...',
			skillMd: '---\nname: test-abc\n---\n',
			skillName: 'test-abc',
			actor: { id: 'actor-1', name: 'Test', description: 'use when' },
			skill: { id: 'skill-1', name: 'test-abc' },
			gapReport: {
				gap_items: [
					{
						topic: 'target segment',
						detail: 'name the segment',
						why_it_matters: 'drives channel choice',
					},
					{
						topic: 'budget',
						detail: 'name the budget',
						why_it_matters: 'bounds the plan',
					},
					{
						topic: 'timeline',
						detail: 'name the timeline',
						why_it_matters: 'orders the plan',
					},
				],
			},
			gapReportMarkdown: '## Gap report for Test\n\n### target segment\n\nname the segment',
			definitionSummary: 'Test — Growth PM. use when',
			gapReportCommentPosted: true,
			reviewerAttempts: [
				{
					cycleNumber: 1,
					overall: 'pass' as const,
					failingCriteria: [],
					reviewerSessionId: 'rev-session-uuid',
					rubricId: RUBRIC_ID,
				},
			],
			reviewerFinalOverall: 'pass' as const,
			...overrides,
		})
	}

	it('returns 200 with actor + skill IDs + reviewer verdict on happy path (workspace_id via body)', async () => {
		stubCreatedResult()

		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/create`, {
				prompt: 'help plan a B2B launch',
				workspace_id: WORKSPACE_ID,
			}),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.actor_id).toBe('actor-1')
		expect(body.skill_id).toBe('skill-1')
		expect(body.persona.name).toBe('Test')
		expect(body.system_prompt).toMatch(/## Background/)
		expect(body.definition_summary).toBe('Test — Growth PM. use when')
		expect(body.gap_report).toContain('## Gap report for Test')
		expect(body.gap_report_items).toHaveLength(3)
		expect(body.gap_report_comment_posted).toBe(true)
		expect(body.reviewer.final_overall).toBe('pass')
		expect(body.reviewer.attempts).toHaveLength(1)
		expect(body.reviewer.attempts[0].reviewer_session_id).toBe('rev-session-uuid')
	})

	it('accepts workspace_id via X-Workspace-Id header', async () => {
		stubCreatedResult({
			actor: { id: 'a', name: 'A', description: '' },
			skill: { id: 's', name: 'test' },
			gapReport: { gap_items: [] },
			gapReportMarkdown: '',
			definitionSummary: '',
			gapReportCommentPosted: false,
		})

		const { app } = createAgentBuilderTestApp()
		const req = new Request(`http://localhost${BASE}/create`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Workspace-Id': WORKSPACE_ID,
			},
			body: JSON.stringify({ prompt: 'plan a launch' }),
		})
		const res = await app.request(req)
		expect(res.status).toBe(200)
	})

	it('returns 200 with gap_question when the pipeline short-circuits', async () => {
		runAgentBuilder.mockResolvedValue({
			kind: 'gap_question',
			gap_question: 'What field and what outcome?',
			missing: ['domain', 'job_to_be_done'],
		})

		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/create`, {
				prompt: 'help me',
				workspace_id: WORKSPACE_ID,
			}),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.gap_question).toMatch(/field and what outcome/)
		expect(body.missing).toEqual(['domain', 'job_to_be_done'])
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

	it('returns 500 when the pipeline throws AgentBuilderError', async () => {
		const { AgentBuilderError } = await import('../../services/agent-builder')
		runAgentBuilder.mockRejectedValue(new AgentBuilderError('llm_http_error', 'boom'))
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/create`, {
				prompt: 'anything',
				workspace_id: WORKSPACE_ID,
			}),
		)
		expect(res.status).toBe(500)
	})

	it('returns 404 and never dispatches the pipeline when the caller is not a member of the body-supplied workspace_id', async () => {
		stubCreatedResult()
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
		expect(runAgentBuilder).not.toHaveBeenCalled()
	})
})

describe('POST /api/agent-builder/review', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined)
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})
	afterEach(() => {
		vi.restoreAllMocks()
		reviewWork.mockReset()
	})

	it('returns 200 with the structured verdict for an object_id review', async () => {
		reviewWork.mockResolvedValue({
			verdict: {
				overall: 'pass',
				criteria: [{ name: 'persona_specificity', pass: true, fix: '' }],
			},
			reviewerSessionId: 'rev-session-uuid',
			rubricId: RUBRIC_ID,
			targetActorId: null,
		})

		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/review`, {
				object_id: OBJECT_ID,
				workspace_id: WORKSPACE_ID,
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.overall).toBe('pass')
		expect(body.rubric_id).toBe(RUBRIC_ID)
		expect(body.reviewer_session_id).toBe('rev-session-uuid')
		expect(body.criteria[0].name).toBe('persona_specificity')
	})

	it('returns 200 with the structured verdict for a session_id review', async () => {
		reviewWork.mockResolvedValue({
			verdict: {
				overall: 'fail',
				criteria: [
					{ name: 'persona_specificity', pass: true, fix: '' },
					{
						name: 'no_hedging_enforcement',
						pass: false,
						fix: 'Add anti-hedging directive.',
					},
				],
			},
			reviewerSessionId: 'rev-session-uuid',
			rubricId: RUBRIC_ID,
			targetActorId: ACTOR_ID,
		})

		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/review`, {
				session_id: SESSION_ID,
				workspace_id: WORKSPACE_ID,
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.overall).toBe('fail')
		expect(body.target_actor_id).toBe(ACTOR_ID)
		expect(body.criteria[1].pass).toBe(false)
	})

	it('returns 400 when both object_id and session_id are provided', async () => {
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/review`, {
				object_id: OBJECT_ID,
				session_id: SESSION_ID,
				workspace_id: WORKSPACE_ID,
			}),
		)
		expect(res.status).toBe(400)
	})

	it('returns 400 when neither object_id nor session_id is provided', async () => {
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/review`, { workspace_id: WORKSPACE_ID }),
		)
		expect(res.status).toBe(400)
	})

	it('returns 400 when workspace_id is missing', async () => {
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(jsonRequest('POST', `${BASE}/review`, { object_id: OBJECT_ID }))
		expect(res.status).toBe(400)
	})

	it('returns 404 when the reviewer target is not found', async () => {
		const { AgentReviewTargetError } = await import('../../services/agent-builder')
		reviewWork.mockRejectedValue(new AgentReviewTargetError('target_not_found', 'Object not found'))
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/review`, {
				object_id: OBJECT_ID,
				workspace_id: WORKSPACE_ID,
			}),
		)
		expect(res.status).toBe(404)
	})

	it('returns 404 and never dispatches when the caller is not a member of the body-supplied workspace_id', async () => {
		const { app, mockResults } = createAgentBuilderTestApp()
		mockResults.select = []

		const res = await app.request(
			jsonRequest('POST', `${BASE}/review`, {
				object_id: OBJECT_ID,
				workspace_id: WORKSPACE_ID,
			}),
		)

		expect(res.status).toBe(404)
		expect(reviewWork).not.toHaveBeenCalled()
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
