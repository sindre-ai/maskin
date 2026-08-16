import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	AgentRefineError,
	AgentReviewTargetError,
	assembleSkillMd,
	assembleSystemPrompt,
	loadReviewTarget,
	refineAgent,
	reviewWork,
	reviewerVerdictWorkflow,
	safeParseJson,
	summariseRefineDiff,
} from '../../services/agent-builder'
import { createMockAgentStorage, createTestContext } from '../setup'

// The service module calls callLlm() directly, so we mock it at the module
// boundary and drive stage responses via a queue.
vi.mock('../../services/llm-call', () => ({
	callLlm: vi.fn(),
}))

// Real implementation by default; individual tests override
// computeReviewerPrecision to exercise reviewerVerdictWorkflow's isolation of
// precision-summary failures from an already-committed review/rating.
vi.mock('../../services/reviewer-verdicts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../services/reviewer-verdicts')>()
	return {
		...actual,
		computeReviewerPrecision: vi.fn(actual.computeReviewerPrecision),
	}
})

const { callLlm: mockedCallLlm } = await import('../../services/llm-call')
const callLlm = mockedCallLlm as unknown as ReturnType<typeof vi.fn>

const { computeReviewerPrecision: mockedComputeReviewerPrecision } = await import(
	'../../services/reviewer-verdicts'
)
const computeReviewerPrecision = mockedComputeReviewerPrecision as unknown as ReturnType<
	typeof vi.fn
>

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111'
const CALLER_ACTOR_ID = '22222222-2222-2222-2222-222222222222'
const CREATED_ACTOR_ID = '33333333-3333-3333-3333-333333333333'
const CREATED_SKILL_ID = '44444444-4444-4444-4444-444444444444'
const RUBRIC_ID = '55555555-5555-5555-5555-555555555555'
const RUBRIC_CONTENT = '# Test rubric\n\nScore against these criteria...'

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
		// object_id reviews with no target_actor_id have nothing to persist
		// against — the verdict is computed but stays unpersisted/unratable.
		expect(out.persisted).toBe(false)
		expect(out.verdictId).toBeNull()
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

describe('reviewerVerdictWorkflow — precision summary isolation', () => {
	beforeEach(() => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})
	afterEach(() => vi.restoreAllMocks())

	it('degrades to precisionSummary: null instead of throwing when computeReviewerPrecision fails', async () => {
		computeReviewerPrecision.mockRejectedValueOnce(new Error('connection reset'))
		const ctxCtx = createTestContext()

		const out = await reviewerVerdictWorkflow(ctxCtx.db, {
			workspaceId: WORKSPACE_ID,
			actorId: CALLER_ACTOR_ID,
			rubricId: RUBRIC_ID,
		})

		// A rubric_id-only call has nothing to review or rate — the point of
		// this test is only that the precision-summary failure doesn't
		// propagate and take down the whole call.
		expect(out.review).toBeNull()
		expect(out.rating).toBeNull()
		expect(out.precisionSummary).toBeNull()
		expect(computeReviewerPrecision).toHaveBeenCalledTimes(1)
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
		// It must also anchor on the actor's actual current system prompt
		// (verbatim) so unrelated sections carry forward instead of drifting —
		// this is the whole point of refineAgent's revision-anchoring fix.
		expect(firstStage3?.user).toMatch(/CURRENT SYSTEM PROMPT/)
		expect(firstStage3?.user).toContain('previous background')
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

describe('safeParseJson', () => {
	it('parses plain JSON', () => {
		expect(safeParseJson('{"a":1}')).toEqual({ a: 1 })
	})

	it('parses JSON wrapped in a ```json fence', () => {
		const raw = '```json\n{"a":1,"b":"two"}\n```'
		expect(safeParseJson(raw)).toEqual({ a: 1, b: 'two' })
	})

	it('parses JSON wrapped in a bare ``` fence', () => {
		const raw = '```\n{"a":1}\n```'
		expect(safeParseJson(raw)).toEqual({ a: 1 })
	})

	it('parses JSON wrapped in a fence with surrounding whitespace', () => {
		const raw = '   \n```json\n{"a":1}\n```   \n'
		expect(safeParseJson(raw)).toEqual({ a: 1 })
	})

	it('parses JSON when the closing fence is missing (truncated at max_tokens)', () => {
		// Simulates the stage 3/6 truncation shape: an open fence, valid JSON,
		// then the response is cut before the closing ``` is emitted.
		const raw = '```json\n{"a":1,"b":"two"}'
		expect(safeParseJson(raw)).toEqual({ a: 1, b: 'two' })
	})

	it('falls back to the {…} substring when there is preamble prose around the JSON', () => {
		const raw = 'Sure! Here is the JSON you asked for:\n{"a":1,"b":2}\nHope that helps.'
		expect(safeParseJson(raw)).toEqual({ a: 1, b: 2 })
	})

	it('falls back to the {…} substring inside a fence with preamble prose', () => {
		const raw = '```json\nHere you go: {"a":1}\n```'
		expect(safeParseJson(raw)).toEqual({ a: 1 })
	})

	it('returns null on unparseable input with no {…} substring', () => {
		expect(safeParseJson('not json at all')).toBeNull()
	})

	it('returns null when the JSON is malformed and cannot be recovered', () => {
		expect(safeParseJson('{"a": ')).toBeNull()
	})
})
