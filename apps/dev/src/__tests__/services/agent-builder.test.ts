import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentBuilderError, runAgentBuilder } from '../../services/agent-builder'

// The service module calls callLlm() directly, so we mock it at the module
// boundary and drive stage-1/stage-2 responses via a queue.
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

describe('runAgentBuilder', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined)
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('proceeds to stage 2 for a well-specified one-liner', async () => {
		queueLlmResponses(
			JSON.stringify({
				domain: 'database migrations',
				job_to_be_done: 'plan zero-downtime schema changes on hot tables',
				deliverables: ['migration plan'],
				constraints: ['no downtime'],
				is_underspecified: false,
				missing: [],
				gap_question: '',
			}),
			JSON.stringify({
				name: 'Sable Ostrik',
				role: 'Senior zero-downtime migration architect',
				backstory:
					'Fifteen years shipping schema changes to hot Postgres tables. Uses a three-step framework: shadow-write, backfill in chunks, cut over behind a feature flag. Known blind spots: undervalues logical replication for cross-region setups, over-indexes on Postgres conventions when advising on MySQL.',
				scope_boundaries: ['Postgres and MySQL only', 'Refuses to advise on NoSQL migrations'],
				delegation_description:
					'Use this agent when you need a concrete plan to change a schema on a table under production traffic.',
				tool_set: ['postgres_mcp', 'github_mcp'],
			}),
		)

		const result = await runAgentBuilder({
			prompt:
				'I need help planning a zero-downtime add-column migration for a 50M-row Postgres users table.',
		})

		expect(result.kind).toBe('persona')
		if (result.kind !== 'persona') throw new Error('narrowing')
		expect(result.persona.name).toBe('Sable Ostrik')
		expect(result.persona.backstory).toMatch(/three-step/)
		expect(result.persona.scope_boundaries.length).toBeGreaterThan(0)
		expect(result.intent.domain).toBe('database migrations')
		expect(callLlm).toHaveBeenCalledTimes(2)
	})

	it('returns gap_question and does not advance to stage 2 for underspecified input', async () => {
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

		const result = await runAgentBuilder({ prompt: 'help me build an agent' })

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

		const result = await runAgentBuilder({ prompt: 'do stuff' })

		expect(result.kind).toBe('gap_question')
		if (result.kind !== 'gap_question') throw new Error('narrowing')
		expect(result.missing).toContain('domain')
		expect(callLlm).toHaveBeenCalledTimes(1)
	})

	it('throws AgentBuilderError with reason llm_no_api_key when LLM is not configured', async () => {
		callLlm.mockReset()
		callLlm.mockResolvedValueOnce({ ok: false, reason: 'no_api_key' })
		await expect(runAgentBuilder({ prompt: 'anything' })).rejects.toBeInstanceOf(AgentBuilderError)
	})

	it('throws AgentBuilderError with reason stage1_parse_error on malformed JSON', async () => {
		queueLlmResponses('this is not JSON at all')
		await expect(runAgentBuilder({ prompt: 'anything' })).rejects.toMatchObject({
			name: 'AgentBuilderError',
			reason: 'stage1_parse_error',
		})
	})

	it('tolerates JSON wrapped in surrounding text (extracts the first object)', async () => {
		queueLlmResponses(
			`Sure, here you go:\n${JSON.stringify({
				domain: 'growth',
				job_to_be_done: 'plan a launch',
				deliverables: [],
				constraints: [],
				is_underspecified: false,
				missing: [],
				gap_question: '',
			})}\nHope this helps.`,
			JSON.stringify({
				name: 'Test',
				role: 'Growth PM',
				backstory:
					'Launched dozens of B2B products. Frames every launch around ICP fit, distribution channel bets, and post-launch feedback loops. Blind spots: undervalues paid acquisition, over-indexes on founder-led sales.',
				scope_boundaries: ['B2B SaaS only'],
				delegation_description: 'Use this agent when you need a concrete launch plan.',
				tool_set: ['slack_mcp'],
			}),
		)

		const result = await runAgentBuilder({ prompt: 'help plan a B2B launch' })
		expect(result.kind).toBe('persona')
	})
})
