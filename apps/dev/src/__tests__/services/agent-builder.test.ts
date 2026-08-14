import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	AgentBuilderError,
	AgentRefineError,
	AgentReviewTargetError,
	assembleSkillMd,
	assembleSystemPrompt,
	composeDefinitionSummary,
	formatGapReportMarkdown,
	loadReviewTarget,
	personaSkillName,
	refineAgent,
	reviewWork,
	runAgentBuilder,
	summariseRefineDiff,
} from '../../services/agent-builder'
import { createMockAgentStorage, createTestContext } from '../setup'

// The service module calls callLlm() directly, so we mock it at the module
// boundary and drive stage responses via a queue.
vi.mock('../../services/llm-call', () => ({
	callLlm: vi.fn(),
}))

// PostHog tracking is fired at the actor-registration success point. Mock the
// wrapper module so we can assert on when it fires (or doesn't) per DoD 5.
vi.mock('../../lib/analytics/agent-builder-events', () => ({
	trackAgentCreated: vi.fn().mockResolvedValue(undefined),
	trackAgentGapReportPosted: vi.fn().mockResolvedValue(undefined),
}))

const { callLlm: mockedCallLlm } = await import('../../services/llm-call')
const callLlm = mockedCallLlm as unknown as ReturnType<typeof vi.fn>

const { trackAgentCreated: mockedTrackAgentCreated } = await import(
	'../../lib/analytics/agent-builder-events'
)
const trackAgentCreated = mockedTrackAgentCreated as unknown as ReturnType<typeof vi.fn>

function queueLlmResponses(...contents: string[]) {
	callLlm.mockReset()
	for (const content of contents) {
		callLlm.mockResolvedValueOnce({ ok: true, content })
	}
}

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111'
const CALLER_ACTOR_ID = '22222222-2222-2222-2222-222222222222'
const CREATED_ACTOR_ID = '33333333-3333-3333-3333-333333333333'
const CREATED_SKILL_ID = '44444444-4444-4444-4444-444444444444'
const RUBRIC_ID = '55555555-5555-5555-5555-555555555555'
const RUBRIC_CONTENT = '# Test rubric\n\nScore against these criteria...'

function buildStage1Well() {
	return JSON.stringify({
		domain: 'database migrations',
		job_to_be_done: 'plan zero-downtime schema changes on hot tables',
		deliverables: ['migration plan'],
		constraints: ['no downtime'],
		is_underspecified: false,
		missing: [],
		gap_question: '',
	})
}

function buildStage2Well() {
	return JSON.stringify({
		name: 'Sable Ostrik',
		role: 'Senior zero-downtime migration architect',
		backstory:
			'Fifteen years shipping schema changes to hot Postgres tables. Uses a three-step framework: shadow-write, backfill in chunks, cut over behind a feature flag. Blind spots: undervalues logical replication for cross-region setups, over-indexes on Postgres conventions when advising on MySQL.',
		scope_boundaries: ['Postgres and MySQL only', 'Refuses to advise on NoSQL migrations'],
		delegation_description:
			'Use this agent when you need a concrete plan to change a schema on a table under production traffic.',
		tool_set: ['postgres_mcp', 'github_mcp'],
	})
}

function buildStage3Well() {
	return JSON.stringify({
		background:
			'Sable is a migration architect who has shipped hundreds of schema changes to hot Postgres tables under load. Bias: favours Postgres idioms.',
		instructions: [
			'Ask for the target table row count before proposing a plan.',
			'Prefer shadow-write + backfill + cut-over over ALTER TABLE.',
			'Never propose downtime windows on tables the caller flagged as hot.',
		],
		decision_framework:
			'Apply the three-step framework: shadow-write, backfill in chunks, cut over behind a feature flag. If any step is impossible, name the constraint and propose a scoped alternative.',
		tool_guidance:
			'Reach for postgres_mcp to inspect table stats. Use github_mcp to open the migration PR. Answer from own knowledge when discussing pattern trade-offs.',
		output_format:
			'Every response has: Diagnosis, Plan (numbered), Risks, Recommendation, Assumptions.',
		bias_statement:
			'You undervalue logical replication for cross-region setups and over-index on Postgres conventions when advising on MySQL. Flag these when they apply.',
		worked_examples: [
			{
				title: 'Add NOT NULL column to hot 50M-row table',
				ask: 'How do we add a NOT NULL column to a 50M-row users table without downtime?',
				response:
					'Diagnosis: standard ALTER holds ACCESS EXCLUSIVE; unacceptable on hot table. Plan: 1) add NULL column; 2) backfill in 10k chunks; 3) add CHECK NOT VALID; 4) VALIDATE constraint; 5) drop check, add NOT NULL. Risks: bloat during backfill. Recommendation: Ship the five-step plan behind a feature flag. Assumptions: users table is under 1TB and you have autovacuum tuned.',
			},
			{
				title: 'Rename a column in production',
				ask: 'Can we just rename user_id to account_id in one migration?',
				response:
					'Diagnosis: an in-place rename breaks every reader still on the old name. Plan: 1) add account_id; 2) dual-write; 3) backfill; 4) switch readers; 5) drop user_id. Recommendation: Reject the one-shot rename and ship the five-step dual-write plan. Assumptions: all readers are in this monorepo and can be migrated within one sprint.',
			},
		],
	})
}

function buildStage6Well() {
	return JSON.stringify({
		gap_items: [
			{
				topic: 'target table row count',
				detail:
					'Provide the row count and average row size of the table being migrated so the agent can pick between shadow-write and dual-write patterns.',
				why_it_matters:
					'The decision framework branches on table size — chunked backfill vs. logical replication depends on it.',
			},
			{
				topic: 'existing autovacuum tuning',
				detail:
					'Say whether the caller has custom autovacuum settings on the target table and, if so, what the thresholds are.',
				why_it_matters:
					'Named blind spot: this agent under-adjusts autovacuum during large backfills; the caller-provided settings anchor it.',
			},
			{
				topic: 'reader migration scope',
				detail: 'List which services or repos read this table today.',
				why_it_matters:
					'The system prompt requires a dual-write plan to migrate every reader — without the list, the agent will guess a scope.',
			},
		],
	})
}

function buildStage4Well() {
	return JSON.stringify({
		opinionation_clause:
			'End every in-domain response with two lines: a "Recommendation:" line that names a concrete action, and an "Assumptions:" line that lists the assumptions the recommendation depends on. Do not use "might", "could", or "it depends" in the recommendation. If the caller\'s ask is genuinely ambiguous, state the assumption and recommend the option that follows from it — do not hedge.',
		recommendation_openings: [
			'Ship the shadow-write plan and cut over behind a feature flag.',
			'Reject the migration and instead run a dual-write for one sprint.',
			'Do the backfill in 10k chunks with autovacuum tuned first.',
		],
		assumption_openings: [
			'Assuming the table is under 1TB and autovacuum is tuned',
			'If you have a maintenance window of at least 30 seconds',
		],
	})
}

function buildReviewerPass() {
	return JSON.stringify({
		criteria: [
			{ name: 'persona_specificity', pass: true, fix: '' },
			{ name: 'opinionation_scaffolding_present', pass: true, fix: '' },
			{ name: 'worked_examples_at_least_two', pass: true, fix: '' },
			{ name: 'no_hedging_enforcement', pass: true, fix: '' },
			{ name: 'scope_boundaries_named', pass: true, fix: '' },
		],
		overall: 'pass',
	})
}

function buildReviewerFail(failNames: string[] = ['no_hedging_enforcement']) {
	return JSON.stringify({
		criteria: [
			'persona_specificity',
			'opinionation_scaffolding_present',
			'worked_examples_at_least_two',
			'no_hedging_enforcement',
			'scope_boundaries_named',
		].map((name) => ({
			name,
			pass: !failNames.includes(name),
			fix: failNames.includes(name)
				? `Fix ${name} — the current definition does not satisfy this criterion.`
				: '',
		})),
		overall: 'fail',
	})
}

/**
 * Insert queue for a happy-path pipeline run (1 attempt, reviewer passes).
 * Order:
 *   1) actor  2) workspace_members  3) workspace_skill  4) agent_skills
 *   5) audit event (actor)  6) audit event (workspace_skill)
 *   7) reviewer_verdict_submitted event (per attempt)
 */
function happyPathInsertQueue(personaName = 'Sable Ostrik') {
	return [
		[{ id: CREATED_ACTOR_ID, type: 'agent', name: personaName, description: 'x' }],
		[],
		[{ id: CREATED_SKILL_ID, workspaceId: WORKSPACE_ID, name: 'sable-ostrik-abc12345' }],
		[],
		[],
		[],
		[], // reviewer_verdict_submitted
	]
}

/**
 * Select queue: the pipeline calls db.select() exactly once during
 * getOrBootstrapCanonicalRubric to look up the workspace's canonical rubric.
 * Returning a row here means bootstrap is a no-op (no rubric insert).
 */
function existingRubricSelectQueue(extra: unknown[][] = []) {
	return [
		[{ id: RUBRIC_ID, content: RUBRIC_CONTENT, title: 'Agent builder — reviewer rubric' }],
		...extra,
	]
}

function buildContext() {
	const { db } = createTestContext()
	const agentStorage = createMockAgentStorage()
	return {
		db,
		agentStorage,
		workspaceId: WORKSPACE_ID,
		actorId: CALLER_ACTOR_ID,
	}
}

describe('runAgentBuilder — full pipeline', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined)
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
		trackAgentCreated.mockClear()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('runs stages 1-4 + reviewer (pass) + 6 in order and registers actor + skill + posts gap report on a well-specified one-liner', async () => {
		queueLlmResponses(
			buildStage1Well(),
			buildStage2Well(),
			buildStage3Well(),
			buildStage4Well(),
			buildReviewerPass(),
			buildStage6Well(),
		)

		const agentStorage = createMockAgentStorage()
		const ctxCtx = createTestContext()
		ctxCtx.mockResults.selectQueue = existingRubricSelectQueue()
		ctxCtx.mockResults.insertQueue = happyPathInsertQueue()

		const result = await runAgentBuilder(
			{
				prompt:
					'I need help planning a zero-downtime add-column migration for a 50M-row Postgres users table.',
			},
			{
				db: ctxCtx.db,
				agentStorage,
				workspaceId: WORKSPACE_ID,
				actorId: CALLER_ACTOR_ID,
			},
		)

		expect(result.kind).toBe('created')
		if (result.kind !== 'created') throw new Error('narrowing')
		// 4 pipeline stages + 1 reviewer pass + 1 stage 6 gap report = 6 LLM calls on the no-revision path.
		expect(callLlm).toHaveBeenCalledTimes(6)
		expect(result.actor.id).toBe(CREATED_ACTOR_ID)
		expect(result.actor.name).toBe('Sable Ostrik')
		expect(result.skill.id).toBe(CREATED_SKILL_ID)
		expect(result.reviewerFinalOverall).toBe('pass')
		expect(result.reviewerAttempts).toHaveLength(1)
		expect(result.reviewerAttempts[0]?.cycleNumber).toBe(1)
		expect(result.reviewerAttempts[0]?.rubricId).toBe(RUBRIC_ID)
		expect(result.reviewerAttempts[0]?.failingCriteria).toEqual([])

		// System prompt contains every section header + opinionation scaffolding.
		expect(result.assembledSystemPrompt).toMatch(/## Background/)
		expect(result.assembledSystemPrompt).toMatch(/## Response protocol/)
		expect(result.assembledSystemPrompt).toMatch(/Recommendation:/)
		expect(result.assembledSystemPrompt).toMatch(/Assumptions:/)

		// SKILL.md progressive disclosure preserved (T3 contract).
		expect(result.skillMd).toMatch(/^---\nname: sable-ostrik-[a-f0-9]{8}\ndescription: /)
		expect(result.skillMd).toMatch(/Reference — Worked examples/)

		// S3 write fired with the assembled SKILL.md body.
		expect(agentStorage.putWorkspaceSkill).toHaveBeenCalledWith(
			WORKSPACE_ID,
			CREATED_SKILL_ID,
			result.skillMd,
		)

		// Stage 6 produced a gap report with concrete items and posted it.
		expect(result.gapReport.gap_items.length).toBeGreaterThanOrEqual(3)
		expect(result.gapReportMarkdown).toContain('target table row count')
		expect(result.gapReportMarkdown).toContain('## Gap report for Sable Ostrik')
		expect(result.gapReportCommentPosted).toBe(true)
		// Definition summary composes the persona for the caller.
		expect(result.definitionSummary).toContain('Sable Ostrik')
		expect(result.definitionSummary).toContain('Senior zero-downtime migration architect')
		// agent_created fires with the workspace + created-actor + generation
		// time properties the ship-metric dashboard queries on.
		expect(trackAgentCreated).toHaveBeenCalledTimes(1)
		const trackCall = trackAgentCreated.mock.calls[0][0]
		expect(trackCall.workspaceId).toBe(WORKSPACE_ID)
		expect(trackCall.actorId).toBe(CREATED_ACTOR_ID)
		expect(typeof trackCall.generationTimeMs).toBe('number')
		expect(trackCall.generationTimeMs).toBeGreaterThanOrEqual(0)
	})

	it('does not fire agent_created on the underspecified early-return path', async () => {
		queueLlmResponses(
			JSON.stringify({
				domain: '',
				job_to_be_done: '',
				deliverables: [],
				constraints: [],
				is_underspecified: true,
				missing: ['domain', 'job_to_be_done'],
				gap_question: 'What field should this agent specialize in?',
			}),
		)

		const result = await runAgentBuilder({ prompt: 'help me build an agent' }, buildContext())

		expect(result.kind).toBe('gap_question')
		expect(trackAgentCreated).not.toHaveBeenCalled()
	})

	it('does not fire agent_created when actor registration fails', async () => {
		queueLlmResponses(buildStage1Well(), buildStage2Well(), buildStage3Well(), buildStage4Well())

		const agentStorage = createMockAgentStorage()
		const ctxCtx = createTestContext()
		// First db.insert() (the actor row) throws inside the tx →
		// registerActorAndSkill catches and wraps as AgentBuilderError.
		ctxCtx.mockResults.insertError = new Error('simulated actor insert failure')

		await expect(
			runAgentBuilder(
				{ prompt: 'plan a zero-downtime add-column migration' },
				{
					db: ctxCtx.db,
					agentStorage,
					workspaceId: WORKSPACE_ID,
					actorId: CALLER_ACTOR_ID,
				},
			),
		).rejects.toMatchObject({ name: 'AgentBuilderError' })

		expect(trackAgentCreated).not.toHaveBeenCalled()
	})

	it('runs stages 3 and 4 in parallel (single Promise.all await)', async () => {
		let stage3Dispatched = false
		let stage4Dispatched = false
		const agentStorage = createMockAgentStorage()
		const ctxCtx = createTestContext()
		ctxCtx.mockResults.selectQueue = existingRubricSelectQueue()
		ctxCtx.mockResults.insertQueue = happyPathInsertQueue()

		callLlm.mockReset()
		callLlm.mockImplementationOnce(async () => ({ ok: true, content: buildStage1Well() }))
		callLlm.mockImplementationOnce(async () => ({ ok: true, content: buildStage2Well() }))
		callLlm.mockImplementationOnce(async () => {
			stage3Dispatched = true
			await new Promise((r) => setTimeout(r, 5))
			expect(stage4Dispatched).toBe(true)
			return { ok: true, content: buildStage3Well() }
		})
		callLlm.mockImplementationOnce(async () => {
			stage4Dispatched = true
			return { ok: true, content: buildStage4Well() }
		})
		callLlm.mockImplementationOnce(async () => ({ ok: true, content: buildReviewerPass() }))
		callLlm.mockImplementationOnce(async () => ({ ok: true, content: buildStage6Well() }))

		await runAgentBuilder(
			{ prompt: 'plan a zero-downtime add-column migration on a hot Postgres table' },
			{
				db: ctxCtx.db,
				agentStorage,
				workspaceId: WORKSPACE_ID,
				actorId: CALLER_ACTOR_ID,
			},
		)

		expect(stage3Dispatched).toBe(true)
		expect(stage4Dispatched).toBe(true)
	})

	it('returns gap_question and does not advance past stage 1 for underspecified input', async () => {
		queueLlmResponses(
			JSON.stringify({
				domain: '',
				job_to_be_done: '',
				deliverables: [],
				constraints: [],
				is_underspecified: true,
				missing: ['domain', 'job_to_be_done'],
				gap_question: 'What field should this agent specialize in, and what should it produce?',
			}),
		)

		const result = await runAgentBuilder({ prompt: 'help me build an agent' }, buildContext())

		expect(result.kind).toBe('gap_question')
		if (result.kind !== 'gap_question') throw new Error('narrowing')
		expect(result.gap_question).toMatch(/field.*agent.*specialize/i)
		expect(result.missing).toEqual(['domain', 'job_to_be_done'])
		expect(callLlm).toHaveBeenCalledTimes(1)
	})

	it('short-circuits when domain or job_to_be_done is blank even if the LLM claims otherwise', async () => {
		queueLlmResponses(
			JSON.stringify({
				domain: '   ',
				job_to_be_done: 'do something',
				deliverables: [],
				constraints: [],
				is_underspecified: false,
				missing: [],
				gap_question: '',
			}),
		)

		const result = await runAgentBuilder({ prompt: 'do stuff' }, buildContext())

		expect(result.kind).toBe('gap_question')
		if (result.kind !== 'gap_question') throw new Error('narrowing')
		expect(result.missing).toContain('domain')
		expect(callLlm).toHaveBeenCalledTimes(1)
	})

	it('throws AgentBuilderError with reason llm_no_api_key when LLM is not configured', async () => {
		callLlm.mockReset()
		callLlm.mockResolvedValueOnce({ ok: false, reason: 'no_api_key' })
		await expect(runAgentBuilder({ prompt: 'anything' }, buildContext())).rejects.toBeInstanceOf(
			AgentBuilderError,
		)
	})

	it('throws AgentBuilderError with reason stage1_parse_error on malformed JSON', async () => {
		queueLlmResponses('this is not JSON at all')
		await expect(runAgentBuilder({ prompt: 'anything' }, buildContext())).rejects.toMatchObject({
			name: 'AgentBuilderError',
			reason: 'stage1_parse_error',
		})
	})

	it('throws AgentBuilderError with reason stage3_parse_error when Stage 3 omits required sections', async () => {
		const badStage3 = JSON.stringify({
			background: '',
			instructions: [],
			decision_framework: '',
			tool_guidance: '',
			output_format: '',
			bias_statement: '',
			worked_examples: [],
		})
		queueLlmResponses(buildStage1Well(), buildStage2Well(), badStage3, buildStage4Well())
		const ctxCtx = createTestContext()
		ctxCtx.mockResults.selectQueue = existingRubricSelectQueue()
		await expect(
			runAgentBuilder(
				{ prompt: 'plan zero-downtime migration' },
				{
					db: ctxCtx.db,
					agentStorage: createMockAgentStorage(),
					workspaceId: WORKSPACE_ID,
					actorId: CALLER_ACTOR_ID,
				},
			),
		).rejects.toMatchObject({ name: 'AgentBuilderError', reason: 'stage3_parse_error' })
	})

	it('throws AgentBuilderError with reason stage3_parse_error when fewer than 2 worked examples are returned', async () => {
		const badStage3 = JSON.stringify({
			background: 'x',
			instructions: ['x'],
			decision_framework: 'x',
			tool_guidance: 'x',
			output_format: 'x',
			bias_statement: 'x',
			worked_examples: [{ title: 't', ask: 'a', response: 'r' }],
		})
		queueLlmResponses(buildStage1Well(), buildStage2Well(), badStage3, buildStage4Well())
		const ctxCtx = createTestContext()
		ctxCtx.mockResults.selectQueue = existingRubricSelectQueue()
		await expect(
			runAgentBuilder(
				{ prompt: 'plan zero-downtime migration' },
				{
					db: ctxCtx.db,
					agentStorage: createMockAgentStorage(),
					workspaceId: WORKSPACE_ID,
					actorId: CALLER_ACTOR_ID,
				},
			),
		).rejects.toMatchObject({ name: 'AgentBuilderError', reason: 'stage3_parse_error' })
	})
})

describe('runAgentBuilder — fresh-context reviewer revision loop', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined)
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('re-runs stages 3-4 on a failing verdict and stops when the next attempt passes', async () => {
		// Queue: stage1, stage2, [stage3+stage4]_attempt1, reviewer_fail,
		//        [stage3+stage4]_attempt2, reviewer_pass
		queueLlmResponses(
			buildStage1Well(),
			buildStage2Well(),
			buildStage3Well(),
			buildStage4Well(),
			buildReviewerFail(['no_hedging_enforcement']),
			buildStage3Well(),
			buildStage4Well(),
			buildReviewerPass(),
		)

		const agentStorage = createMockAgentStorage()
		const ctxCtx = createTestContext()
		ctxCtx.mockResults.selectQueue = existingRubricSelectQueue()
		// Extra event insert for the 2nd reviewer attempt.
		ctxCtx.mockResults.insertQueue = [...happyPathInsertQueue(), []]

		const result = await runAgentBuilder(
			{
				prompt: 'plan a zero-downtime add-column migration for a 50M-row Postgres users table.',
			},
			{
				db: ctxCtx.db,
				agentStorage,
				workspaceId: WORKSPACE_ID,
				actorId: CALLER_ACTOR_ID,
			},
		)

		expect(result.kind).toBe('created')
		if (result.kind !== 'created') throw new Error('narrowing')
		// stage1 + stage2 + (stage3+stage4 twice) + (reviewer twice) = 8 calls
		expect(callLlm).toHaveBeenCalledTimes(8)
		expect(result.reviewerFinalOverall).toBe('pass')
		expect(result.reviewerAttempts.map((a) => a.overall)).toEqual(['fail', 'pass'])
		expect(result.reviewerAttempts[0]?.failingCriteria).toEqual(['no_hedging_enforcement'])
		expect(result.reviewerAttempts[1]?.failingCriteria).toEqual([])

		// Attempt 2's stage-3 dispatch must carry revision feedback derived from
		// the failing verdict's fix note. Second stage-3 call is index 5 (0-4
		// were stage1, stage2, stage3, stage4, reviewer).
		const secondStage3Call = callLlm.mock.calls[5]?.[0] as { user: string } | undefined
		expect(secondStage3Call?.user).toMatch(/REVISION FEEDBACK/)
		expect(secondStage3Call?.user).toMatch(/no_hedging_enforcement/)
	})

	it('caps at 2 revision cycles and ships the best-effort definition on a persistently failing reviewer', async () => {
		// 4 stages then reviewer_fail 3 times, with 2 more stage3+stage4 pairs
		// between failures. Total LLM calls: 2 + 3*(2 stages + 1 reviewer) = 11
		queueLlmResponses(
			buildStage1Well(),
			buildStage2Well(),
			buildStage3Well(),
			buildStage4Well(),
			buildReviewerFail(),
			buildStage3Well(),
			buildStage4Well(),
			buildReviewerFail(),
			buildStage3Well(),
			buildStage4Well(),
			buildReviewerFail(),
		)

		const agentStorage = createMockAgentStorage()
		const ctxCtx = createTestContext()
		ctxCtx.mockResults.selectQueue = existingRubricSelectQueue()
		// 3 reviewer_verdict_submitted events after actor creation.
		ctxCtx.mockResults.insertQueue = [...happyPathInsertQueue(), [], []]

		const result = await runAgentBuilder(
			{ prompt: 'plan a zero-downtime migration' },
			{
				db: ctxCtx.db,
				agentStorage,
				workspaceId: WORKSPACE_ID,
				actorId: CALLER_ACTOR_ID,
			},
		)

		expect(result.kind).toBe('created')
		if (result.kind !== 'created') throw new Error('narrowing')
		expect(callLlm).toHaveBeenCalledTimes(11)
		expect(result.reviewerFinalOverall).toBe('fail')
		expect(result.reviewerAttempts).toHaveLength(3)
		// Actor still registered — cap is an escape hatch, not a blocker.
		expect(result.actor.id).toBe(CREATED_ACTOR_ID)
	})

	it('proceeds past a reviewer LLM failure without aborting the whole builder', async () => {
		callLlm.mockReset()
		callLlm.mockResolvedValueOnce({ ok: true, content: buildStage1Well() })
		callLlm.mockResolvedValueOnce({ ok: true, content: buildStage2Well() })
		callLlm.mockResolvedValueOnce({ ok: true, content: buildStage3Well() })
		callLlm.mockResolvedValueOnce({ ok: true, content: buildStage4Well() })
		// Reviewer call — return an error result. runAgentReviewer throws
		// AgentReviewerError; runAgentBuilder catches it and proceeds.
		callLlm.mockResolvedValueOnce({ ok: false, reason: 'http_error', status: 502 })

		const agentStorage = createMockAgentStorage()
		const ctxCtx = createTestContext()
		ctxCtx.mockResults.selectQueue = existingRubricSelectQueue()
		ctxCtx.mockResults.insertQueue = happyPathInsertQueue()

		const result = await runAgentBuilder(
			{ prompt: 'plan a zero-downtime migration' },
			{
				db: ctxCtx.db,
				agentStorage,
				workspaceId: WORKSPACE_ID,
				actorId: CALLER_ACTOR_ID,
			},
		)

		expect(result.kind).toBe('created')
		if (result.kind !== 'created') throw new Error('narrowing')
		expect(result.reviewerFinalOverall).toBe('fail')
		expect(result.reviewerAttempts).toEqual([])
		expect(result.actor.id).toBe(CREATED_ACTOR_ID)
	})

	it('bootstraps a canonical rubric on the first run when none exists', async () => {
		queueLlmResponses(
			buildStage1Well(),
			buildStage2Well(),
			buildStage3Well(),
			buildStage4Well(),
			buildReviewerPass(),
		)

		const agentStorage = createMockAgentStorage()
		const ctxCtx = createTestContext()
		// Empty select → bootstrap inserts the rubric object, then the pipeline
		// continues. Insert order: rubric bootstrap, then the happy-path chain.
		ctxCtx.mockResults.selectQueue = [[]]
		ctxCtx.mockResults.insertQueue = [
			[{ id: RUBRIC_ID }], // rubric bootstrap
			...happyPathInsertQueue(),
		]

		const result = await runAgentBuilder(
			{ prompt: 'plan a zero-downtime migration' },
			{
				db: ctxCtx.db,
				agentStorage,
				workspaceId: WORKSPACE_ID,
				actorId: CALLER_ACTOR_ID,
			},
		)

		expect(result.kind).toBe('created')
		if (result.kind !== 'created') throw new Error('narrowing')
		// The first insert captured by the mock must be the rubric object.
		const firstInsert = ctxCtx.calls.inserts[0] as { type?: string; title?: string } | undefined
		expect(firstInsert?.type).toBe('agent_builder_rubric')
		expect(firstInsert?.title).toBe('Agent builder — reviewer rubric')
	})
})

describe('reviewWork — standalone reviewer', () => {
	beforeEach(() => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})
	afterEach(() => vi.restoreAllMocks())

	it('reviews an object.content payload against the workspace rubric', async () => {
		callLlm.mockReset()
		callLlm.mockResolvedValueOnce({ ok: true, content: buildReviewerPass() })

		const OBJECT_ID = '77777777-7777-7777-7777-777777777777'
		const ctxCtx = createTestContext()
		ctxCtx.mockResults.selectQueue = [
			// loadReviewTarget: fetch the object row
			[{ content: '# draft skill body\n\n## Response protocol …', workspaceId: WORKSPACE_ID }],
			// getOrBootstrapCanonicalRubric: fetch the rubric row (exists)
			[{ id: RUBRIC_ID, content: RUBRIC_CONTENT, title: 'Rubric' }],
		]

		const out = await reviewWork(ctxCtx.db, {
			workspaceId: WORKSPACE_ID,
			actorId: CALLER_ACTOR_ID,
			objectId: OBJECT_ID,
		})

		expect(out.verdict.overall).toBe('pass')
		expect(out.rubricId).toBe(RUBRIC_ID)
		expect(out.targetActorId).toBeNull()
		expect(callLlm).toHaveBeenCalledTimes(1)
	})

	it('rejects a session_id review when the session is still running', async () => {
		const SESSION_ID = '88888888-8888-8888-8888-888888888888'
		const ctxCtx = createTestContext()
		ctxCtx.mockResults.selectQueue = [
			// loadReviewTarget: session row with non-terminal status
			[
				{
					status: 'running',
					result: null,
					workspaceId: WORKSPACE_ID,
					actorId: CREATED_ACTOR_ID,
				},
			],
		]

		await expect(
			reviewWork(ctxCtx.db, {
				workspaceId: WORKSPACE_ID,
				actorId: CALLER_ACTOR_ID,
				sessionId: SESSION_ID,
			}),
		).rejects.toMatchObject({ name: 'AgentReviewTargetError', reason: 'session_not_terminal' })
	})

	it("rejects an object whose workspace_id does not match the caller's workspace", async () => {
		const OBJECT_ID = '77777777-7777-7777-7777-777777777777'
		const OTHER_WS = '99999999-9999-9999-9999-999999999999'
		const ctxCtx = createTestContext()
		ctxCtx.mockResults.selectQueue = [[{ content: 'anything', workspaceId: OTHER_WS }]]

		await expect(
			reviewWork(ctxCtx.db, {
				workspaceId: WORKSPACE_ID,
				actorId: CALLER_ACTOR_ID,
				objectId: OBJECT_ID,
			}),
		).rejects.toMatchObject({ name: 'AgentReviewTargetError', reason: 'target_wrong_workspace' })
	})

	it('surfaces target_not_found when the object does not exist', async () => {
		const OBJECT_ID = '77777777-7777-7777-7777-777777777777'
		const ctxCtx = createTestContext()
		ctxCtx.mockResults.selectQueue = [[]]
		await expect(
			reviewWork(ctxCtx.db, {
				workspaceId: WORKSPACE_ID,
				actorId: CALLER_ACTOR_ID,
				objectId: OBJECT_ID,
			}),
		).rejects.toMatchObject({ name: 'AgentReviewTargetError', reason: 'target_not_found' })
	})
})

describe('refineAgent', () => {
	beforeEach(() => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})
	afterEach(() => vi.restoreAllMocks())

	it('re-runs stages 3-4 with the refinement context and republishes the SKILL.md', async () => {
		callLlm.mockReset()
		callLlm.mockResolvedValueOnce({ ok: true, content: buildStage3Well() })
		callLlm.mockResolvedValueOnce({ ok: true, content: buildStage4Well() })

		const ctxCtx = createTestContext()
		ctxCtx.mockResults.selectQueue = [
			// actors + workspace_members join → returns the current actor row
			[
				{
					id: CREATED_ACTOR_ID,
					name: 'Sable Ostrik',
					description: 'Use this agent when planning zero-downtime migrations.',
					systemPrompt: '# Sable Ostrik\n\n## Background\n\nprevious background',
				},
			],
			// workspace_skills + agent_skills join → returns the attached skill
			[
				{
					id: CREATED_SKILL_ID,
					name: 'sable-ostrik-abc12345',
					description: 'Use this agent when planning zero-downtime migrations.',
				},
			],
		]
		ctxCtx.mockResults.insertQueue = [
			[], // audit event
		]

		const agentStorage = createMockAgentStorage()
		const out = await refineAgent(
			{ db: ctxCtx.db, agentStorage, workspaceId: WORKSPACE_ID, actorId: CALLER_ACTOR_ID },
			{
				actorId: CREATED_ACTOR_ID,
				context: 'Sharpen the bias statement — name at least two blind spots.',
			},
		)

		expect(callLlm).toHaveBeenCalledTimes(2)
		expect(out.updatedActorId).toBe(CREATED_ACTOR_ID)
		expect(out.newSystemPrompt).toMatch(/## Response protocol/)
		expect(out.diff).toContain('length changed by')
		expect(agentStorage.putWorkspaceSkill).toHaveBeenCalledWith(
			WORKSPACE_ID,
			CREATED_SKILL_ID,
			expect.stringContaining('---'),
		)
		// The stage-3 call must carry the refinement context as revision feedback.
		const firstStage3 = callLlm.mock.calls[0]?.[0] as { user: string } | undefined
		expect(firstStage3?.user).toMatch(/REVISION FEEDBACK/)
		expect(firstStage3?.user).toMatch(/Sharpen the bias statement/)
	})

	it('rejects refinement when the context is empty or whitespace-only', async () => {
		await expect(
			refineAgent(buildContext(), { actorId: CREATED_ACTOR_ID, context: '   ' }),
		).rejects.toMatchObject({ name: 'AgentRefineError', reason: 'refine_context_empty' })
	})

	it("rejects refinement when the actor is not in the caller's workspace", async () => {
		const ctxCtx = createTestContext()
		ctxCtx.mockResults.selectQueue = [[]]
		await expect(
			refineAgent(
				{
					db: ctxCtx.db,
					agentStorage: createMockAgentStorage(),
					workspaceId: WORKSPACE_ID,
					actorId: CALLER_ACTOR_ID,
				},
				{ actorId: CREATED_ACTOR_ID, context: 'do a thing' },
			),
		).rejects.toMatchObject({ name: 'AgentRefineError', reason: 'actor_wrong_workspace' })
	})

	it('rejects refinement when the actor has no attached SKILL.md', async () => {
		const ctxCtx = createTestContext()
		ctxCtx.mockResults.selectQueue = [
			[
				{
					id: CREATED_ACTOR_ID,
					name: 'Sable Ostrik',
					description: 'x',
					systemPrompt: '# old',
				},
			],
			[], // no skill attached
		]
		await expect(
			refineAgent(
				{
					db: ctxCtx.db,
					agentStorage: createMockAgentStorage(),
					workspaceId: WORKSPACE_ID,
					actorId: CALLER_ACTOR_ID,
				},
				{ actorId: CREATED_ACTOR_ID, context: 'do a thing' },
			),
		).rejects.toMatchObject({ name: 'AgentRefineError', reason: 'skill_not_found' })
	})
})

describe('loadReviewTarget', () => {
	it('returns the actorId from a terminal session so the verdict can be joined back', async () => {
		const SESSION_ID = '88888888-8888-8888-8888-888888888888'
		const ctxCtx = createTestContext()
		ctxCtx.mockResults.selectQueue = [
			[
				{
					status: 'completed',
					result: { output: 'final work product' },
					workspaceId: WORKSPACE_ID,
					actorId: CREATED_ACTOR_ID,
				},
			],
		]
		const out = await loadReviewTarget(ctxCtx.db, WORKSPACE_ID, { sessionId: SESSION_ID })
		expect(out.definitionText).toContain('final work product')
		expect(out.targetActorId).toBe(CREATED_ACTOR_ID)
	})
})

describe('summariseRefineDiff', () => {
	it('reports added and removed section headers', () => {
		const previous = '# actor\n\n## Background\n\nold\n\n## Instructions\n\nold instrs'
		const next = '# actor\n\n## Background\n\nnew\n\n## Response protocol\n\nnew protocol'
		const diff = summariseRefineDiff(previous, next)
		expect(diff).toContain('added sections: Response protocol')
		expect(diff).toContain('removed sections: Instructions')
		expect(diff).toContain('length changed by')
	})

	it('names the no-previous case explicitly', () => {
		const diff = summariseRefineDiff('', '## new\n\nx')
		expect(diff).toMatch(/no previous version/i)
	})
})

describe('personaSkillName', () => {
	it('slugifies name to lowercase-hyphens with a random suffix', () => {
		const name = personaSkillName('Sable Ostrik')
		expect(name).toMatch(/^sable-ostrik-[a-f0-9]{8}$/)
	})

	it('sanitizes non-alphanumeric characters', () => {
		const name = personaSkillName("O'Neill & Sons, Data Migrations!")
		expect(name).toMatch(/^o-neill-sons-data-migrations-[a-f0-9]{8}$/)
	})

	it('falls back to a stable stub when the name has no alphanumeric characters', () => {
		const name = personaSkillName('!!!')
		expect(name).toMatch(/^sme-agent-[a-f0-9]{8}$/)
	})

	it('always produces two independent calls with distinct suffixes', () => {
		const a = personaSkillName('Sable Ostrik')
		const b = personaSkillName('Sable Ostrik')
		expect(a).not.toEqual(b)
	})
})

describe('assembleSystemPrompt', () => {
	const persona = {
		name: 'Sable Ostrik',
		role: 'Senior migration architect',
		backstory: 'x',
		scope_boundaries: [],
		delegation_description: 'Use when planning a zero-downtime migration.',
		tool_set: [],
	}
	const sections = {
		background: 'BG',
		instructions: ['Do A', 'Do B'],
		decision_framework: 'FRAME',
		tool_guidance: 'TOOLS',
		output_format: 'FORMAT',
		bias_statement: 'BIAS',
		worked_examples: [
			{ title: 't1', ask: 'a1', response: 'r1' },
			{ title: 't2', ask: 'a2', response: 'r2' },
		],
	}
	const opinionation = {
		opinionation_clause: 'End with Recommendation: and Assumptions:. Do not hedge.',
		recommendation_openings: ['Ship X', 'Do Y'],
		assumption_openings: ['Assuming Z'],
	}

	it('emits every required section header', () => {
		const prompt = assembleSystemPrompt(persona, sections, opinionation)
		for (const header of [
			'## Background',
			'## Instructions',
			'## Decision framework',
			'## Tool guidance',
			'## Output format',
			'## Named biases and blind spots',
			'## Response protocol',
		]) {
			expect(prompt).toContain(header)
		}
	})

	it('embeds the opinionation clause verbatim so anti-hedging is a system-prompt directive, not a post-hoc filter', () => {
		const prompt = assembleSystemPrompt(persona, sections, opinionation)
		expect(prompt).toContain(opinionation.opinionation_clause)
	})

	it('renders each instruction as a bullet', () => {
		const prompt = assembleSystemPrompt(persona, sections, opinionation)
		expect(prompt).toContain('- Do A')
		expect(prompt).toContain('- Do B')
	})
})

describe('assembleSkillMd — progressive disclosure', () => {
	const persona = {
		name: 'Sable Ostrik',
		role: 'Senior migration architect',
		backstory: 'x',
		scope_boundaries: [],
		delegation_description: 'Use this agent when planning zero-downtime schema changes.',
		tool_set: [],
	}
	const sections = {
		background: 'BG',
		instructions: ['Do A'],
		decision_framework: 'FRAME',
		tool_guidance: 'TOOLS',
		output_format: 'FORMAT',
		bias_statement: 'BIAS',
		worked_examples: [
			{ title: 't1', ask: 'a1', response: 'r1' },
			{ title: 't2', ask: 'a2', response: 'r2' },
		],
	}
	const opinionation = {
		opinionation_clause: 'End with Recommendation: and Assumptions:.',
		recommendation_openings: ['Ship X'],
		assumption_openings: ['Assuming Z'],
	}

	it('lightweight-metadata tier: frontmatter carries only name and one-line description', () => {
		const md = assembleSkillMd('sable-ostrik-abc12345', persona, sections, opinionation)
		expect(md).toMatch(/^---\nname: sable-ostrik-abc12345\ndescription: Use this agent when/)
		const closingIndex = md.indexOf('\n---\n', 4)
		expect(closingIndex).toBeGreaterThan(0)
		const frontmatter = md.slice(0, closingIndex)
		expect(frontmatter).not.toContain('Background')
		expect(frontmatter).not.toContain('Worked examples')
	})

	it('on-activation tier: system prompt sections live in the body', () => {
		const md = assembleSkillMd('sable-ostrik-abc12345', persona, sections, opinionation)
		expect(md).toContain('## Background')
		expect(md).toContain('## Response protocol')
	})

	it('on-demand tier: worked examples land in the reference section marked "load on demand"', () => {
		const md = assembleSkillMd('sable-ostrik-abc12345', persona, sections, opinionation)
		expect(md).toContain('# Reference — Worked examples')
		expect(md).toMatch(/Load this section only when/)
		expect(md).toContain('## t1')
		expect(md).toContain('## t2')
	})
})

describe('composeDefinitionSummary', () => {
	it('renders name — role. delegation_description on one line', () => {
		const summary = composeDefinitionSummary({
			name: 'Sable Ostrik',
			role: 'Senior migration architect',
			backstory: '',
			scope_boundaries: [],
			delegation_description: 'Use when planning a zero-downtime schema change.',
			tool_set: [],
		})
		expect(summary).toBe(
			'Sable Ostrik — Senior migration architect. Use when planning a zero-downtime schema change.',
		)
	})
})

describe('formatGapReportMarkdown', () => {
	const persona = {
		name: 'Sable Ostrik',
		role: 'Senior migration architect',
		backstory: '',
		scope_boundaries: [],
		delegation_description: 'Use when planning a zero-downtime schema change.',
		tool_set: [],
	}
	const report = {
		gap_items: [
			{
				topic: 'target table row count',
				detail: 'Provide the row count.',
				why_it_matters: 'Framework branches on it.',
			},
			{
				topic: 'existing autovacuum tuning',
				detail: 'Say whether autovacuum is tuned.',
				why_it_matters: 'Neutralises the named blind spot.',
			},
		],
	}

	it('renders a persona-headed report with topic headings and reasons', () => {
		const md = formatGapReportMarkdown(persona, report)
		expect(md).toContain('## Gap report for Sable Ostrik')
		expect(md).toContain('### target table row count')
		expect(md).toContain('### existing autovacuum tuning')
		expect(md).toContain('Provide the row count.')
		expect(md).toContain('_Why it matters:_ Neutralises the named blind spot.')
	})
})

describe('runAgentBuilder — stage 6 gap report', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined)
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	function buildRunContext() {
		const agentStorage = createMockAgentStorage()
		const ctxCtx = createTestContext()
		ctxCtx.mockResults.insertQueue = [
			[{ id: CREATED_ACTOR_ID, name: 'Sable Ostrik', description: 'x' }],
			[],
			[{ id: CREATED_SKILL_ID, name: 'sable-ostrik-abc12345' }],
			[],
			[],
			[],
			[],
		]
		return { agentStorage, ctxCtx }
	}

	it('posts the gap report as a commented event with entityType=actor on the new actor', async () => {
		queueLlmResponses(
			buildStage1Well(),
			buildStage2Well(),
			buildStage3Well(),
			buildStage4Well(),
			buildStage6Well(),
		)
		const { agentStorage, ctxCtx } = buildRunContext()

		const result = await runAgentBuilder(
			{ prompt: 'plan a zero-downtime add-column migration' },
			{
				db: ctxCtx.db,
				agentStorage,
				workspaceId: WORKSPACE_ID,
				actorId: CALLER_ACTOR_ID,
			},
		)

		expect(result.kind).toBe('created')
		if (result.kind !== 'created') throw new Error('narrowing')
		expect(result.gapReportCommentPosted).toBe(true)

		// The comment insert has to carry action='commented' with entityType='actor'
		// pointing at the newly created actor id, and its `content` must be the
		// rendered gap-report markdown — otherwise the caller sees no gap report.
		const commentInsert = ctxCtx.calls.inserts.find(
			(row) => (row as { action?: string }).action === 'commented',
		) as
			| {
					action: string
					entityType: string
					entityId: string
					data: { content: string; source?: string }
					workspaceId: string
					actorId: string
			  }
			| undefined
		expect(commentInsert).toBeDefined()
		if (!commentInsert) throw new Error('narrowing')
		expect(commentInsert.action).toBe('commented')
		expect(commentInsert.entityType).toBe('actor')
		expect(commentInsert.entityId).toBe(CREATED_ACTOR_ID)
		expect(commentInsert.workspaceId).toBe(WORKSPACE_ID)
		expect(commentInsert.actorId).toBe(CALLER_ACTOR_ID)
		expect(commentInsert.data.source).toBe('agent_builder_gap_report')
		expect(commentInsert.data.content).toContain('## Gap report for Sable Ostrik')
		expect(commentInsert.data.content).toContain('target table row count')
	})

	it('degrades gracefully when the comment insert fails: report still returned, commentPosted=false', async () => {
		queueLlmResponses(
			buildStage1Well(),
			buildStage2Well(),
			buildStage3Well(),
			buildStage4Well(),
			buildStage6Well(),
		)
		const { agentStorage, ctxCtx } = buildRunContext()
		// The 7th insert (gap-report comment) rejects; the 6 prior inserts
		// (actor + skill + audits) succeed via the queue.
		ctxCtx.mockResults.insertErrorQueue = [
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			new Error('boom'),
		]

		const result = await runAgentBuilder(
			{ prompt: 'plan a zero-downtime add-column migration' },
			{
				db: ctxCtx.db,
				agentStorage,
				workspaceId: WORKSPACE_ID,
				actorId: CALLER_ACTOR_ID,
			},
		)

		expect(result.kind).toBe('created')
		if (result.kind !== 'created') throw new Error('narrowing')
		expect(result.gapReportCommentPosted).toBe(false)
		expect(result.gapReportMarkdown).toContain('## Gap report for Sable Ostrik')
	})

	it('throws AgentBuilderError with reason stage6_parse_error on malformed gap-report JSON', async () => {
		queueLlmResponses(
			buildStage1Well(),
			buildStage2Well(),
			buildStage3Well(),
			buildStage4Well(),
			JSON.stringify({ gap_items: [] }), // fails min(1)
		)
		const { agentStorage, ctxCtx } = buildRunContext()

		await expect(
			runAgentBuilder(
				{ prompt: 'plan a zero-downtime add-column migration' },
				{
					db: ctxCtx.db,
					agentStorage,
					workspaceId: WORKSPACE_ID,
					actorId: CALLER_ACTOR_ID,
				},
			),
		).rejects.toMatchObject({ name: 'AgentBuilderError', reason: 'stage6_parse_error' })
	})

	it('never invokes stage 6 or posts a comment on the underspec short-circuit', async () => {
		queueLlmResponses(
			JSON.stringify({
				domain: '',
				job_to_be_done: '',
				deliverables: [],
				constraints: [],
				is_underspecified: true,
				missing: ['domain', 'job_to_be_done'],
				gap_question: 'What field and what outcome?',
			}),
		)
		const agentStorage = createMockAgentStorage()
		const ctxCtx = createTestContext()

		const result = await runAgentBuilder(
			{ prompt: 'help me' },
			{
				db: ctxCtx.db,
				agentStorage,
				workspaceId: WORKSPACE_ID,
				actorId: CALLER_ACTOR_ID,
			},
		)

		expect(result.kind).toBe('gap_question')
		expect(callLlm).toHaveBeenCalledTimes(1)
		// No inserts of any kind — no actor, no comment.
		expect(ctxCtx.calls.inserts).toHaveLength(0)
		expect(agentStorage.putWorkspaceSkill).not.toHaveBeenCalled()
	})
})
