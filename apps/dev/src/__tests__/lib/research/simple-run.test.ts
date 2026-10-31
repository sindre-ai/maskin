import { describe, expect, it, vi } from 'vitest'
import type { LLMResponse } from '../../../lib/llm/adapter'
import { createQueryScrub } from '../../../lib/research/scrub'
import { ResearchProviderError } from '../../../lib/research/search-provider'
import type { ResearchSearchProvider } from '../../../lib/research/search-provider'
import { runSimpleResearch } from '../../../lib/research/simple-run'

vi.mock('../../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const URL_A = 'https://www.retsinformation.dk/eli/lta/2022/700'
const PAGE =
	'Bogføringsloven gælder for erhvervsdrivende. Regnskabsmateriale skal opbevares i fem år efter regnskabsårets udløb.'
const QUOTE = 'Regnskabsmateriale skal opbevares i fem år efter regnskabsårets udløb.'
const pricing = { prompt: 1e-6, completion: 5e-6, cacheRead: 0, cacheWrite: 0 }

const usage = (input: number, output: number) => ({
	input_tokens: input,
	output_tokens: output,
	cache_creation_input_tokens: 0,
	cache_read_input_tokens: 0,
})

const toolTurn = (
	name: string,
	args: Record<string, unknown>,
	tokens = usage(1500, 40),
): LLMResponse => ({
	content: null,
	tool_calls: [{ id: `call-${name}`, name, arguments: args }],
	finish_reason: 'tool_calls',
	usage: tokens,
})

const textTurn = (content: string, tokens = usage(1000, 200)): LLMResponse => ({
	content,
	tool_calls: [],
	finish_reason: 'stop',
	usage: tokens,
})

const researcherJson = (findings: unknown[], gaps: string[] = []) =>
	JSON.stringify({ findings, unread: [], gaps })

const goodFinding = {
	claim: 'Materialet opbevares i fem år.',
	quote: QUOTE,
	url: URL_A,
	title: 'Bogføringsloven',
	publisher: 'Retsinformation',
	date: '2022-05-24',
	source_type: 'primary',
	confidence: 0.9,
}

/** Answers the model calls in order and keeps every request it saw. */
function scriptedAdapter(script: LLMResponse[]) {
	const calls: Array<Parameters<import('../../../lib/llm/adapter').LLMAdapter['chat']>[0]> = []
	return {
		calls,
		chat: vi.fn(async (options: (typeof calls)[number]) => {
			calls.push(options)
			const next = script.shift()
			if (!next) throw new Error('the model was called more often than the test expected')
			return next
		}),
	}
}

function fakeSearch(over: Partial<ResearchSearchProvider> = {}) {
	return {
		name: 'fake',
		searchPriceMicroUsd: 8_000,
		extractUrlPriceMicroUsd: 1_600,
		search: vi.fn(async () => ({
			hits: [
				{
					title: 'Bogføringsloven',
					url: URL_A,
					snippet: 'Loven om bogføring',
					publishedDate: '2022-05-24',
				},
			],
			costMicroUsd: 8_000,
		})),
		extract: vi.fn(async (urls: string[]) => ({
			pages: urls.map((url) => ({ url, text: PAGE })),
			failed: [],
			costMicroUsd: urls.length * 1_600,
		})),
		...over,
	} satisfies ResearchSearchProvider
}

const base = {
	question: 'Hvor længe skal bogføringsmateriale opbevares?',
	context: null,
	model: 'm',
	pricing,
	scrub: createQueryScrub([]),
}

describe('runSimpleResearch', () => {
	it('returns a cited report with a Method section and the run totals', async () => {
		const adapter = scriptedAdapter([
			toolTurn('web_search', { query: 'bogføringsloven opbevaring', denmark: true }),
			toolTurn('web_fetch', { urls: [URL_A] }, usage(1800, 40)),
			textTurn(researcherJson([goodFinding]), usage(3000, 400)),
			textTurn(
				'## TL;DR\nMaterialet opbevares i fem år [1].\n\n## Confidence\nHøj.',
				usage(900, 150),
			),
		])
		const search = fakeSearch()

		const out = await runSimpleResearch({ ...base, capCents: 100, adapter, search })

		expect(out.status).toBe('done')
		expect(out.reportMd).toContain('[1]')
		expect(out.reportMd).toContain('## Sources')
		expect(out.reportMd).toContain('## Method')
		expect(out.reportMd).toContain('"bogføringsloven opbevaring"')
		expect(out.sources).toHaveLength(1)
		expect(out.searches).toBe(1)
		expect(out.extracts).toBe(1)
		expect(out.researchers).toBe(1)
		expect(out.tier12Share).toBe(1)
		expect(out.costCents).toBeGreaterThan(0)
		expect(out.costCents).toBeLessThanOrEqual(100)
		expect(out.tokensIn).toBe(1500 + 1800 + 3000 + 900)
		// The Denmark boost is passed through, and the writer call has no tools.
		expect(search.search).toHaveBeenCalledWith(expect.objectContaining({ boostDenmark: true }))
		expect(adapter.calls[3]?.tools).toBeUndefined()
	})

	it('hands the assistant tool calls back with the tool results on the next turn', async () => {
		const adapter = scriptedAdapter([
			toolTurn('web_search', { query: 'x' }),
			textTurn(researcherJson([])),
			textTurn('## TL;DR\nNo source found for x.'),
		])
		await runSimpleResearch({ ...base, capCents: 100, adapter, search: fakeSearch() })

		const second = adapter.calls[1]?.messages ?? []
		const assistant = second.find((m) => m.role === 'assistant')
		expect(assistant?.tool_calls?.[0]?.name).toBe('web_search')
		expect(second.find((m) => m.role === 'tool')?.tool_call_id).toBe('call-web_search')
	})

	it('ends a $0.05 run as capped, with a plain warning at the top of the report', async () => {
		const adapter = scriptedAdapter([
			toolTurn('web_search', { query: 'x' }, usage(6000, 40)),
			textTurn(researcherJson([], ['not enough budget to read any page']), usage(1500, 100)),
			textTurn('## TL;DR\nNo source found.', usage(500, 50)),
		])

		const out = await runSimpleResearch({ ...base, capCents: 5, adapter, search: fakeSearch() })

		expect(out.status).toBe('capped')
		expect(out.reportMd?.startsWith('> **Warning:**')).toBe(true)
		expect(out.reportMd).toContain('not enough budget to read any page')
		expect(out.warnings[0]).toContain('cost cap')
		// No page was read: the researcher was stopped at the call boundary, not mid-call.
		expect(out.extracts).toBe(0)
		expect(out.costCents).toBeLessThanOrEqual(5)
		// The writer's output limit came from what was left in its share, not the default.
		const writerCall = adapter.calls[2]
		expect(writerCall?.max_tokens).toBeLessThan(4_000)
	})

	it('makes no model call and lists what it has when not even one turn fits the cap', async () => {
		const adapter = scriptedAdapter([])
		const out = await runSimpleResearch({
			...base,
			capCents: 1,
			adapter,
			search: fakeSearch(),
			pricing: { prompt: 1e-5, completion: 5e-5, cacheRead: 0, cacheWrite: 0 },
		})
		expect(adapter.chat).not.toHaveBeenCalled()
		expect(out.status).toBe('capped')
		expect(out.costCents).toBe(0)
		expect(out.warnings.join(' ')).toContain('did not leave room for the writer')
		expect(out.reportMd?.startsWith('> **Warning:**')).toBe(true)
	})

	it('fails with a plain reason when the researcher does not return the JSON, and keeps the cost', async () => {
		const adapter = scriptedAdapter([textTurn('I could not do it', usage(500, 20))])
		const out = await runSimpleResearch({ ...base, capCents: 100, adapter, search: fakeSearch() })
		expect(out.status).toBe('failed')
		expect(out.error).toBe('The researcher did not return findings in the expected format.')
		expect(out.reportMd).toBeNull()
		expect(out.costCents).toBe(1)
	})

	it('drops a finding whose quote is not on the page and says so', async () => {
		const adapter = scriptedAdapter([
			toolTurn('web_fetch', { urls: [URL_A] }),
			textTurn(researcherJson([goodFinding, { ...goodFinding, quote: 'not on the page' }])),
			textTurn('## TL;DR\nFive years [1].'),
		])
		const out = await runSimpleResearch({ ...base, capCents: 100, adapter, search: fakeSearch() })
		expect(out.status).toBe('done')
		expect(out.warnings).toContain('Findings dropped: 1 with a quote not found on the page.')
		expect((out.findings as unknown[]).length).toBe(1)
	})

	it('reads pages only through the provider extract, three URLs at most per call', async () => {
		const search = fakeSearch()
		const adapter = scriptedAdapter([
			toolTurn('web_fetch', { urls: [URL_A, 'https://a.dk', 'https://b.dk', 'https://c.dk'] }),
			textTurn(researcherJson([])),
			textTurn('## TL;DR\nNothing.'),
		])
		await runSimpleResearch({ ...base, capCents: 100, adapter, search })
		// At most 3 URLs per call, all through the provider's extract.
		expect(search.extract).toHaveBeenCalledTimes(1)
		expect(search.extract.mock.calls[0]?.[0]).toHaveLength(3)
	})

	it('ends the run as failed when the provider rejects the key, with the cost so far', async () => {
		const search = fakeSearch({
			search: vi.fn(async () => {
				throw new ResearchProviderError('Tavily rejected the API key', { status: 401 })
			}),
		})
		const adapter = scriptedAdapter([toolTurn('web_search', { query: 'x' })])
		const out = await runSimpleResearch({ ...base, capCents: 100, adapter, search })
		expect(out.status).toBe('failed')
		expect(out.error).toContain('Tavily rejected the API key')
		expect(out.costCents).toBe(1)
	})

	it('treats a retryable provider failure as a tool result and carries on', async () => {
		const search = fakeSearch({
			search: vi.fn(async () => {
				throw new ResearchProviderError('Tavily /search timed out', { retryable: true })
			}),
		})
		const adapter = scriptedAdapter([
			toolTurn('web_search', { query: 'x' }),
			textTurn(researcherJson([])),
			textTurn('## TL;DR\nNothing.'),
		])
		const out = await runSimpleResearch({ ...base, capCents: 100, adapter, search })
		expect(out.status).toBe('done')
		expect(adapter.calls[1]?.messages.at(-1)?.content).toContain('timed out')
	})

	it('stops at the deadline and writes from what it has', async () => {
		let t = 0
		const adapter = scriptedAdapter([textTurn(researcherJson([])), textTurn('## TL;DR\nNothing.')])
		const out = await runSimpleResearch({
			...base,
			capCents: 100,
			adapter,
			search: fakeSearch(),
			deadlineMs: 1_000,
			now: () => {
				t += 2_000
				return t
			},
		})
		expect(out.status).toBe('capped')
		expect(out.warnings[0]).toContain('20 minute limit')
		expect(out.reportMd).toContain('ran out of time')
	})

	it('returns a failed outcome with the cost so far when the model call throws', async () => {
		const adapter = {
			chat: vi
				.fn()
				.mockResolvedValueOnce(toolTurn('web_search', { query: 'x' }))
				.mockRejectedValueOnce(new Error('Anthropic API error: 529 overloaded')),
		}
		const out = await runSimpleResearch({ ...base, capCents: 100, adapter, search: fakeSearch() })
		expect(out.status).toBe('failed')
		expect(out.error).toContain('529 overloaded')
		expect(out.searches).toBe(1)
	})
})
