import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgentBuilder, runStage1, runStage2 } from '../../services/agent-builder'

// Two LLM responses are queued in `mockFetch` per pipeline run: stage 1 output
// then stage 2 output. When the pipeline short-circuits on underspecified
// input, only the stage 1 response should be consumed — asserted via
// fetchMock.mock.calls.length.

function mockFetch(...jsonBodies: object[]) {
	const fetchMock = vi.fn()
	for (const body of jsonBodies) {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				choices: [{ message: { content: JSON.stringify(body) } }],
			}),
		})
	}
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

const wellSpecifiedStage1 = {
	domain: 'SEO consulting',
	job_to_be_done: 'audit landing pages for on-page SEO improvements',
	deliverables: ['prioritised issue list', 'before/after checklist'],
	constraints: ['budget-conscious', 'no paid ads'],
	is_underspecified: false,
	gap_question: '',
}

const wellSpecifiedStage2 = {
	name: 'Riley Okonkwo',
	role: 'Senior on-page SEO auditor',
	backstory:
		'Ten years auditing SaaS marketing sites; former head of SEO at two Series-A startups. Applies a strict crawl-first, semantics-second methodology, and always ships prioritised recommendations tied to measurable wins. Biased toward measurable rankings gains over brand plays; distrusts vanity metrics like Domain Authority.',
	scope_boundaries: ['does not advise on paid ads', 'will not write frontend code'],
	delegation_description:
		'Use this agent when a Series-A SaaS team needs an opinionated on-page SEO audit with a prioritised action list.',
	tool_set: ['read_url', 'search_web', 'create_report'],
}

const underspecifiedStage1 = {
	domain: '',
	job_to_be_done: '',
	deliverables: [],
	constraints: [],
	is_underspecified: true,
	gap_question:
		'What specific field should this agent be an expert in, and what task should it perform?',
}

describe('agent-builder pipeline', () => {
	beforeEach(() => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'test-key'
		vi.spyOn(console, 'log').mockImplementation(() => undefined)
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = undefined
	})

	it('well-specified prompt proceeds through stage 2 and returns a persona', async () => {
		const fetchMock = mockFetch(wellSpecifiedStage1, wellSpecifiedStage2)

		const result = await runAgentBuilder({
			prompt:
				'SEO auditor for early-stage SaaS landing pages, budget-conscious, prefers on-page fixes over paid.',
		})

		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(result.status).toBe('ok')
		if (result.status !== 'ok') return
		expect(result.intent.domain).toBe('SEO consulting')
		expect(result.persona.name).toBe('Riley Okonkwo')
		expect(result.persona.role).toBe('Senior on-page SEO auditor')
		expect(result.persona.tool_set.length).toBeGreaterThan(0)
	})

	it('underspecified prompt returns gap_question and does not advance to stage 2', async () => {
		const fetchMock = mockFetch(underspecifiedStage1)

		const result = await runAgentBuilder({ prompt: 'help me' })

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(result.status).toBe('underspecified')
		if (result.status !== 'underspecified') return
		expect(result.gap_question).toBe(underspecifiedStage1.gap_question)
		expect(result.intent.is_underspecified).toBe(true)
	})

	it('underspecified branch falls back to a generic gap question when the model omits one', async () => {
		const fetchMock = mockFetch({ ...underspecifiedStage1, gap_question: '' })

		const result = await runAgentBuilder({ prompt: 'thing' })

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(result.status).toBe('underspecified')
		if (result.status !== 'underspecified') return
		expect(result.gap_question.length).toBeGreaterThan(0)
	})

	it('stage 1 verifies both LLM calls run at temperature ≤0.3', async () => {
		const fetchMock = mockFetch(wellSpecifiedStage1, wellSpecifiedStage2)

		await runAgentBuilder({ prompt: 'SEO auditor for SaaS.' })

		const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string))
		expect(bodies).toHaveLength(2)
		for (const body of bodies) {
			expect(body.temperature).toBeLessThanOrEqual(0.3)
		}
	})

	it('surfaces llm_unavailable when the fallback key is missing', async () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = ''

		const result = await runAgentBuilder({ prompt: 'anything' })

		expect(result.status).toBe('error')
		if (result.status !== 'error') return
		expect(result.reason).toBe('llm_unavailable')
	})

	it('stage 1 tolerates JSON wrapped in a markdown code fence', async () => {
		const fenced = `\`\`\`json\n${JSON.stringify(wellSpecifiedStage1)}\n\`\`\``
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ choices: [{ message: { content: fenced } }] }),
			}),
		)

		const stage1 = await runStage1({ prompt: 'SEO auditor' })
		expect(stage1.ok).toBe(true)
		if (stage1.ok) expect(stage1.intent.domain).toBe('SEO consulting')
	})

	it('runStage2 returns parse_error when the model omits required fields', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					choices: [{ message: { content: JSON.stringify({ name: 'Alex' }) } }],
				}),
			}),
		)

		const stage2 = await runStage2(
			{ prompt: 'SEO auditor' },
			{
				domain: 'SEO',
				job_to_be_done: 'audit',
				deliverables: [],
				constraints: [],
				is_underspecified: false,
				gap_question: '',
			},
		)

		expect(stage2.ok).toBe(false)
		if (!stage2.ok) expect(stage2.reason).toBe('stage_2_parse_error')
	})
})
