import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	AgentReviewerError,
	CANONICAL_RUBRIC_TITLE,
	DEFAULT_RUBRIC_BODY,
	REVIEWER_VERDICT_SUBMITTED,
	RUBRIC_OBJECT_TYPE,
	failingCriteriaNames,
	getOrBootstrapCanonicalRubric,
	resolveRubricById,
	runAgentReviewer,
	trackReviewerVerdictSubmitted,
} from '../../services/agent-reviewer'
import { createTestContext } from '../setup'

vi.mock('../../services/llm-call', () => ({
	callLlm: vi.fn(),
}))
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

const { callLlm: mockedCallLlm } = await import('../../services/llm-call')
const callLlm = mockedCallLlm as unknown as ReturnType<typeof vi.fn>
const { capturePosthogEvent: mockedPosthog } = await import('../../lib/analytics/posthog')
const capturePosthogEvent = mockedPosthog as unknown as ReturnType<typeof vi.fn>

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111'
const ACTOR_ID = '22222222-2222-2222-2222-222222222222'
const TARGET_ACTOR_ID = '33333333-3333-3333-3333-333333333333'
const RUBRIC_ID = '55555555-5555-5555-5555-555555555555'

function validVerdictJson(overall: 'pass' | 'fail' = 'pass') {
	return JSON.stringify({
		criteria: [
			{ name: 'persona_specificity', pass: true, fix: '' },
			{
				name: 'opinionation_scaffolding_present',
				pass: overall === 'pass',
				fix:
					overall === 'fail'
						? 'Add a Response protocol section that literally requires "Recommendation:" and "Assumptions:" lines.'
						: '',
			},
		],
		overall,
	})
}

describe('runAgentReviewer', () => {
	beforeEach(() => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
		callLlm.mockReset()
	})
	afterEach(() => vi.restoreAllMocks())

	it('parses a well-formed verdict and returns a fresh reviewer_session_id', async () => {
		callLlm.mockResolvedValueOnce({ ok: true, content: validVerdictJson('pass') })
		const out = await runAgentReviewer({
			definitionText:
				'# Some agent\n\n## Response protocol\n\nEnd with Recommendation: and Assumptions:.',
			rubricBody: '# Rubric\n\n- Persona specificity\n- Opinionation scaffolding\n',
		})
		expect(out.verdict.overall).toBe('pass')
		expect(out.verdict.criteria).toHaveLength(2)
		expect(out.reviewerSessionId).toMatch(/^[0-9a-f-]{36}$/)
	})

	it('passes the rubric + definition as an isolated call — no producer prior turns', async () => {
		callLlm.mockResolvedValueOnce({ ok: true, content: validVerdictJson('pass') })
		await runAgentReviewer({
			definitionText: '# Draft agent\n\n## Background\n\nsome background',
			rubricBody: '# Rubric\n\ncriteria go here',
		})
		expect(callLlm).toHaveBeenCalledTimes(1)
		const call = callLlm.mock.calls[0]?.[0] as {
			system: string
			user: string
			temperature: number
		}
		// Isolation contract: the reviewer's user message contains ONLY the two
		// labelled sections (RUBRIC + DEFINITION) — no producer conversation
		// artefacts, no stage-1/2/3/4 outputs, no message history.
		expect(call?.user).toContain('## RUBRIC')
		expect(call?.user).toContain('criteria go here')
		expect(call?.user).toContain('## DEFINITION')
		expect(call?.user).toContain('# Draft agent')
		expect(call?.user).not.toContain('DOMAIN:')
		expect(call?.user).not.toContain('PERSONA NAME:')
		expect(call?.system).toContain('You did NOT author this draft')
		expect(call?.temperature).toBeLessThanOrEqual(0.3)
	})

	it('throws reviewer_parse_error on malformed JSON', async () => {
		callLlm.mockResolvedValueOnce({ ok: true, content: 'not json at all' })
		await expect(runAgentReviewer({ definitionText: 'x', rubricBody: 'y' })).rejects.toMatchObject({
			name: 'AgentReviewerError',
			reason: 'reviewer_parse_error',
		})
	})

	it('throws reviewer_parse_error when the verdict omits overall', async () => {
		callLlm.mockResolvedValueOnce({
			ok: true,
			content: JSON.stringify({
				criteria: [{ name: 'x', pass: true, fix: '' }],
			}),
		})
		await expect(runAgentReviewer({ definitionText: 'x', rubricBody: 'y' })).rejects.toMatchObject({
			name: 'AgentReviewerError',
			reason: 'reviewer_parse_error',
		})
	})

	it('throws llm_no_api_key when the LLM key is unset', async () => {
		callLlm.mockResolvedValueOnce({ ok: false, reason: 'no_api_key' })
		await expect(runAgentReviewer({ definitionText: 'x', rubricBody: 'y' })).rejects.toBeInstanceOf(
			AgentReviewerError,
		)
	})
})

describe('getOrBootstrapCanonicalRubric', () => {
	beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined))
	afterEach(() => vi.restoreAllMocks())

	it('returns the existing canonical rubric without inserting when one is present', async () => {
		const ctxCtx = createTestContext()
		ctxCtx.mockResults.selectQueue = [
			[{ id: RUBRIC_ID, content: '# custom rubric', title: CANONICAL_RUBRIC_TITLE }],
		]
		const out = await getOrBootstrapCanonicalRubric(ctxCtx.db, WORKSPACE_ID, ACTOR_ID)
		expect(out.id).toBe(RUBRIC_ID)
		expect(out.content).toBe('# custom rubric')
		expect(ctxCtx.calls.inserts).toEqual([])
	})

	it('falls back to DEFAULT_RUBRIC_BODY when the existing row was cleared to empty', async () => {
		const ctxCtx = createTestContext()
		ctxCtx.mockResults.selectQueue = [
			[{ id: RUBRIC_ID, content: '   ', title: CANONICAL_RUBRIC_TITLE }],
		]
		const out = await getOrBootstrapCanonicalRubric(ctxCtx.db, WORKSPACE_ID, ACTOR_ID)
		expect(out.content).toBe(DEFAULT_RUBRIC_BODY)
	})

	it('bootstraps a new rubric object when none exists', async () => {
		const ctxCtx = createTestContext()
		ctxCtx.mockResults.selectQueue = [[]]
		ctxCtx.mockResults.insertQueue = [[{ id: RUBRIC_ID }]]
		const out = await getOrBootstrapCanonicalRubric(ctxCtx.db, WORKSPACE_ID, ACTOR_ID)
		expect(out.id).toBe(RUBRIC_ID)
		expect(out.content).toBe(DEFAULT_RUBRIC_BODY)
		const insert = ctxCtx.calls.inserts[0] as {
			type?: string
			workspaceId?: string
			title?: string
			content?: string
			status?: string
			createdBy?: string
		}
		expect(insert.type).toBe(RUBRIC_OBJECT_TYPE)
		expect(insert.workspaceId).toBe(WORKSPACE_ID)
		expect(insert.title).toBe(CANONICAL_RUBRIC_TITLE)
		expect(insert.status).toBe('active')
		expect(insert.createdBy).toBe(ACTOR_ID)
		expect(insert.content).toBe(DEFAULT_RUBRIC_BODY)
	})
})

describe('resolveRubricById', () => {
	it('returns null when the id points at a different workspace', async () => {
		const ctxCtx = createTestContext()
		ctxCtx.mockResults.selectQueue = [
			[{ id: RUBRIC_ID, content: '# rubric', workspaceId: 'OTHER-WORKSPACE-ID' }],
		]
		const out = await resolveRubricById(ctxCtx.db, WORKSPACE_ID, RUBRIC_ID)
		expect(out).toBeNull()
	})

	it('returns the resolved rubric when it belongs to the caller workspace', async () => {
		const ctxCtx = createTestContext()
		ctxCtx.mockResults.selectQueue = [
			[{ id: RUBRIC_ID, content: '# rubric', workspaceId: WORKSPACE_ID }],
		]
		const out = await resolveRubricById(ctxCtx.db, WORKSPACE_ID, RUBRIC_ID)
		expect(out?.id).toBe(RUBRIC_ID)
	})
})

describe('trackReviewerVerdictSubmitted — on-the-wire event', () => {
	beforeEach(() => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		capturePosthogEvent.mockClear()
	})
	afterEach(() => vi.restoreAllMocks())

	it('writes an events row but does not capture a PostHog event (recordReviewerVerdict owns that)', async () => {
		const ctxCtx = createTestContext()
		await trackReviewerVerdictSubmitted(ctxCtx.db, {
			workspaceId: WORKSPACE_ID,
			actorId: ACTOR_ID,
			targetActorId: TARGET_ACTOR_ID,
			rubricId: RUBRIC_ID,
			overall: 'fail',
			cycleNumber: 2,
			reviewerSessionId: 'reviewer-session-uuid',
			failingCriteria: ['no_hedging_enforcement'],
		})

		const insert = ctxCtx.calls.inserts[0] as {
			action?: string
			workspaceId?: string
			actorId?: string
			entityType?: string
			entityId?: string
			data?: Record<string, unknown>
		}
		expect(insert.action).toBe(REVIEWER_VERDICT_SUBMITTED)
		expect(insert.workspaceId).toBe(WORKSPACE_ID)
		expect(insert.entityType).toBe('actor')
		expect(insert.entityId).toBe(TARGET_ACTOR_ID)
		expect(insert.data?.overall).toBe('fail')
		expect(insert.data?.cycle_number).toBe(2)
		expect(insert.data?.reviewer_session_id).toBe('reviewer-session-uuid')
		expect(insert.data?.rubric_id).toBe(RUBRIC_ID)
		expect(insert.data?.failing_criteria).toEqual(['no_hedging_enforcement'])

		// recordReviewerVerdict (reviewer-verdicts.ts) is the sole PostHog
		// emitter for reviewer_verdict_submitted once a verdict is persisted —
		// see this function's doc comment for why firing it here too would
		// double the ship-metric count.
		expect(capturePosthogEvent).not.toHaveBeenCalled()
	})

	it('anchors the events row to the rubric object when no target actor exists yet', async () => {
		const ctxCtx = createTestContext()
		await trackReviewerVerdictSubmitted(ctxCtx.db, {
			workspaceId: WORKSPACE_ID,
			actorId: ACTOR_ID,
			targetActorId: null,
			rubricId: RUBRIC_ID,
			overall: 'pass',
			cycleNumber: 1,
			reviewerSessionId: 'reviewer-session-uuid',
			failingCriteria: [],
		})
		const insert = ctxCtx.calls.inserts[0] as { entityType?: string; entityId?: string }
		expect(insert.entityType).toBe('object')
		expect(insert.entityId).toBe(RUBRIC_ID)
	})
})

describe('failingCriteriaNames', () => {
	it('returns only the names of failing criteria', () => {
		const verdict = {
			overall: 'fail' as const,
			criteria: [
				{ name: 'a', pass: true, fix: '' },
				{ name: 'b', pass: false, fix: 'fix b' },
				{ name: 'c', pass: false, fix: 'fix c' },
			],
		}
		expect(failingCriteriaNames(verdict)).toEqual(['b', 'c'])
	})
})
