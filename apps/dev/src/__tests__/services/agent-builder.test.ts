import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	AgentBuilderError,
	assembleSkillMd,
	assembleSystemPrompt,
	composeDefinitionSummary,
	formatGapReportMarkdown,
	personaSkillName,
	runAgentBuilder,
} from '../../services/agent-builder'
import { createMockAgentStorage, createTestContext } from '../setup'

// The service module calls callLlm() directly, so we mock it at the module
// boundary and drive stage responses via a queue.
vi.mock('../../services/llm-call', () => ({
	callLlm: vi.fn(),
}))

const { callLlm: mockedCallLlm } = await import('../../services/llm-call')
const callLlm = mockedCallLlm as unknown as ReturnType<typeof vi.fn>

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
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('runs stages 1-4 + 6 in order and registers actor + skill + posts gap report on a well-specified one-liner', async () => {
		queueLlmResponses(
			buildStage1Well(),
			buildStage2Well(),
			buildStage3Well(),
			buildStage4Well(),
			buildStage6Well(),
		)

		const agentStorage = createMockAgentStorage()
		const ctxCtx = createTestContext()
		// Each db.insert() call shifts one entry from the queue. Order:
		//   1) actor  2) workspace_members  3) workspace_skill  4) agent_skills
		//   5) audit event (actor)  6) audit event (workspace_skill)
		//   7) gap-report comment event on the actor (from stage 6)
		ctxCtx.mockResults.insertQueue = [
			[
				{
					id: CREATED_ACTOR_ID,
					type: 'agent',
					name: 'Sable Ostrik',
					description: 'Use this agent when you need a concrete plan',
				},
			],
			// workspace_members insert — no returning, but chain resolves []
			[],
			[
				{
					id: CREATED_SKILL_ID,
					workspaceId: WORKSPACE_ID,
					name: 'sable-ostrik-abc12345',
				},
			],
			// agent_skills insert — no returning
			[],
			// audit event inserts
			[],
			[],
			// stage 6 gap-report comment insert
			[],
		]

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
		expect(callLlm).toHaveBeenCalledTimes(5)
		expect(result.actor.id).toBe(CREATED_ACTOR_ID)
		expect(result.actor.name).toBe('Sable Ostrik')
		expect(result.skill.id).toBe(CREATED_SKILL_ID)

		// System prompt contains every section header + opinionation scaffolding.
		expect(result.assembledSystemPrompt).toMatch(/## Background/)
		expect(result.assembledSystemPrompt).toMatch(/## Instructions/)
		expect(result.assembledSystemPrompt).toMatch(/## Decision framework/)
		expect(result.assembledSystemPrompt).toMatch(/## Tool guidance/)
		expect(result.assembledSystemPrompt).toMatch(/## Output format/)
		expect(result.assembledSystemPrompt).toMatch(/## Named biases and blind spots/)
		expect(result.assembledSystemPrompt).toMatch(/## Response protocol/)
		expect(result.assembledSystemPrompt).toMatch(/Recommendation:/)
		expect(result.assembledSystemPrompt).toMatch(/Assumptions:/)

		// SKILL.md frontmatter carries the lightweight metadata; the sectioned
		// system prompt lives in the body. Worked examples land in the
		// on-demand reference section, not the always-loaded frontmatter.
		expect(result.skillMd).toMatch(/^---\nname: sable-ostrik-[a-f0-9]{8}\ndescription: /)
		expect(result.skillMd).toMatch(/Reference — Worked examples/)
		expect(result.skillMd).not.toMatch(/description:.*Background/)

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
	})

	it('runs stages 3 and 4 in parallel (single Promise.all await)', async () => {
		// If stages 3 and 4 were serialized, stage-4 would only dispatch after
		// stage-3 resolved. Assert stage-4 dispatches while stage-3 is still
		// pending — proves the Promise.all path.
		let stage3Dispatched = false
		let stage4Dispatched = false
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

		callLlm.mockReset()
		callLlm.mockImplementationOnce(async () => ({ ok: true, content: buildStage1Well() }))
		callLlm.mockImplementationOnce(async () => ({ ok: true, content: buildStage2Well() }))
		callLlm.mockImplementationOnce(async () => {
			stage3Dispatched = true
			// Yield once so stage-4 dispatch happens before stage-3 resolves,
			// but only if the pipeline actually parallelised them.
			await new Promise((r) => setTimeout(r, 5))
			expect(stage4Dispatched).toBe(true)
			return { ok: true, content: buildStage3Well() }
		})
		callLlm.mockImplementationOnce(async () => {
			stage4Dispatched = true
			return { ok: true, content: buildStage4Well() }
		})
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
		await expect(
			runAgentBuilder({ prompt: 'plan zero-downtime migration' }, buildContext()),
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
		await expect(
			runAgentBuilder({ prompt: 'plan zero-downtime migration' }, buildContext()),
		).rejects.toMatchObject({ name: 'AgentBuilderError', reason: 'stage3_parse_error' })
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
		// Frontmatter section ends after the second `---`.
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
