import { describe, expect, it, vi } from 'vitest'
import type { LLMAdapter, LLMResponse, LLMUsage } from '../../../lib/llm/adapter'
import { estimateTokens } from '../../../lib/research/ledger'
import {
	LEAD_SYSTEM_PROMPT,
	RESEARCHER_SYSTEM_PROMPT,
	WRITER_SYSTEM_PROMPT,
} from '../../../lib/research/prompts'
import { runResearch } from '../../../lib/research/run'
import { SCRUB_REJECTION_MESSAGE, createQueryScrub } from '../../../lib/research/scrub'
import type { ResearchSearchProvider, SearchParams } from '../../../lib/research/search-provider'

vi.mock('../../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

type ChatOptions = Parameters<LLMAdapter['chat']>[0]
type Reply = Omit<LLMResponse, 'usage'> & { usage?: LLMUsage }

const pricing = { prompt: 1e-6, completion: 5e-6, cacheRead: 0, cacheWrite: 0 }
const SENTENCE = 'The rate is 25 percent for topic pages.'
const docUrl = (i: number) => `https://www.retsinformation.dk/doc/${i}`
const pageFor = (url: string) => `Content of ${url}. ${SENTENCE}`

const toolReply = (name: string, args: Record<string, unknown>): Reply => ({
	content: null,
	tool_calls: [{ id: 'call-1', name, arguments: args }],
	finish_reason: 'tool_calls',
})
const textReply = (content: string): Reply => ({
	content,
	tool_calls: [],
	finish_reason: 'stop',
})
const noFindings = () => textReply(JSON.stringify({ findings: [], unread: [], gaps: [] }))

const findingFor = (i: number, over: Record<string, unknown> = {}) => ({
	claim: `Claim ${i}`,
	quote: SENTENCE,
	url: docUrl(i),
	title: `Doc ${i}`,
	publisher: 'Skat',
	date: '2026-01-01',
	source_type: 'primary',
	confidence: 0.9,
	...over,
})

const leadReply = (n: number): Reply =>
	textReply(
		JSON.stringify({
			interpretation: 'Reading of the question',
			subtopics: Array.from({ length: n }, (_, i) => ({
				objective: `Topic ${i}`,
				sub_questions: [`Question ${i}?`],
				source_hints: ['official documentation'],
				boundaries: 'The other researchers cover the rest',
				tool_call_limit: 8,
			})),
		}),
	)

/** search, fetch its own document, then report one finding. */
function standardResearcher({ topic, turn }: { topic: string; turn: number }): Reply {
	const i = Number(topic.replace(/\D/g, ''))
	if (turn === 0) return toolReply('web_search', { query: `public query ${topic}` })
	if (turn === 1) return toolReply('web_fetch', { urls: [docUrl(i)] })
	return textReply(JSON.stringify({ findings: [findingFor(i)], unread: [], gaps: [] }))
}

interface Handlers {
	lead?: (options: ChatOptions) => Reply | Promise<Reply>
	researcher?: (ctx: { topic: string; turn: number; options: ChatOptions }) =>
		| Reply
		| Promise<Reply>
	writer?: (options: ChatOptions) => Reply | Promise<Reply>
}

/**
 * Answers each model call by who is asking (the system prompt tells the lead, a
 * researcher and the writer apart), so tests do not depend on the order parallel
 * researchers call in. Usage is what the call would really cost at its worst
 * (input as estimated, output at max_tokens) unless the reply sets its own.
 */
function routedAdapter(handlers: Handlers) {
	const calls = {
		lead: [] as ChatOptions[],
		researcher: [] as ChatOptions[],
		writer: [] as ChatOptions[],
	}
	const realistic = (options: ChatOptions): LLMUsage => ({
		input_tokens: estimateTokens(options.messages.map((m) => m.content).join('\n')),
		output_tokens: options.max_tokens ?? 0,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
	})
	const chat = vi.fn(async (options: ChatOptions): Promise<LLMResponse> => {
		const system = options.messages[0]?.content
		let reply: Reply
		if (system === LEAD_SYSTEM_PROMPT) {
			calls.lead.push(options)
			reply = await (handlers.lead ?? (() => leadReply(2)))(options)
		} else if (system === WRITER_SYSTEM_PROMPT) {
			calls.writer.push(options)
			reply = await (handlers.writer ?? (() => textReply('## TL;DR\nRates are 25 percent [1].')))(
				options,
			)
		} else if (system === RESEARCHER_SYSTEM_PROMPT) {
			calls.researcher.push(options)
			const user = options.messages[1]?.content ?? ''
			const topic = /Your subtopic: (.*)/.exec(user)?.[1] ?? 'simple'
			const turn = options.messages.filter((m) => m.role === 'assistant').length
			reply = await (handlers.researcher ?? standardResearcher)({ topic, turn, options })
		} else {
			throw new Error('a model call from an unknown stage')
		}
		return { ...reply, usage: reply.usage ?? realistic(options) }
	})
	return { chat, calls }
}

function fakeSearch() {
	return {
		name: 'fake',
		searchPriceMicroUsd: 8_000,
		extractUrlPriceMicroUsd: 1_600,
		search: vi.fn(async (_params: SearchParams) => ({
			hits: [
				{ title: 'A page', url: docUrl(0), snippet: 'An excerpt', publishedDate: '2026-01-01' },
			],
			costMicroUsd: 8_000,
		})),
		extract: vi.fn(async (urls: string[]) => ({
			pages: urls.map((url) => ({ url, text: pageFor(url) })),
			failed: [],
			costMicroUsd: urls.length * 1_600,
		})),
	} satisfies ResearchSearchProvider
}

const base = {
	question: 'Compare the VAT rules',
	context: null,
	model: 'm',
	pricing,
	scrub: createQueryScrub([]),
}

describe('runResearch: lead and researchers', () => {
	it('makes no lead call for simple effort and runs one researcher', async () => {
		const adapter = routedAdapter({})
		const out = await runResearch({
			...base,
			effort: 'simple',
			capCents: 100,
			adapter,
			search: fakeSearch(),
		})
		expect(adapter.calls.lead).toHaveLength(0)
		expect(out.researchers).toBe(1)
		expect(out.status).toBe('done')
		expect(Object.keys(out.stages).sort()).toEqual(['researcher', 'writer'])
	})

	it('writes a brief with the lead, then runs one researcher per subtopic with its own instructions', async () => {
		const adapter = routedAdapter({ lead: () => leadReply(3) })
		const search = fakeSearch()
		const out = await runResearch({
			...base,
			effort: 'comparison',
			capCents: 400,
			adapter,
			search,
		})

		expect(adapter.calls.lead).toHaveLength(1)
		// The lead plans; it has no tools to search with.
		expect(adapter.calls.lead[0]?.tools).toBeUndefined()
		expect(out.researchers).toBe(3)
		expect(out.status).toBe('done')

		const firstPrompts = adapter.calls.researcher
			.filter((o) => o.messages.length === 2)
			.map((o) => o.messages[1]?.content ?? '')
		expect(firstPrompts).toHaveLength(3)
		for (const [i, prompt] of firstPrompts.sort().entries()) {
			expect(prompt).toContain(`Your subtopic: Topic ${i}`)
			expect(prompt).toContain('Boundaries')
			expect(prompt).toContain('at most 8 tool calls')
		}
		// The writer gets the lead's reading of the question.
		expect(adapter.calls.writer[0]?.messages[1]?.content).toContain('Reading of the question')

		expect(out.sources.map((s) => s.n)).toEqual([1, 2, 3])
		expect(out.reportMd).toContain('## Sources')
		expect(out.reportMd).toContain('Effort: comparison (3 researchers)')
		expect(Object.keys(out.stages).sort()).toEqual([
			'lead',
			'researcher:0',
			'researcher:1',
			'researcher:2',
			'writer',
		])
	})

	it('cuts a brief with more subtopics than the effort allows', async () => {
		const adapter = routedAdapter({ lead: () => leadReply(6) })
		const out = await runResearch({
			...base,
			effort: 'comparison',
			capCents: 400,
			adapter,
			search: fakeSearch(),
		})
		expect(out.researchers).toBe(4)
	})

	it('numbers a page that two researchers both read once', async () => {
		const adapter = routedAdapter({
			lead: () => leadReply(2),
			researcher: ({ turn }) => {
				if (turn === 0) return toolReply('web_fetch', { urls: [docUrl(0)] })
				return textReply(JSON.stringify({ findings: [findingFor(0)], unread: [], gaps: [] }))
			},
		})
		const out = await runResearch({
			...base,
			effort: 'comparison',
			capCents: 400,
			adapter,
			search: fakeSearch(),
		})
		expect(out.sources).toHaveLength(1)
		expect((out.findings as Array<{ n: number }>).map((f) => f.n)).toEqual([1, 1])
	})

	it('fails with a plain reason, keeping the lead cost, when the lead does not return a brief', async () => {
		const adapter = routedAdapter({ lead: () => textReply('Let me think about that.') })
		const out = await runResearch({
			...base,
			effort: 'comparison',
			capCents: 400,
			adapter,
			search: fakeSearch(),
		})
		expect(out.status).toBe('failed')
		expect(out.error).toBe('The lead did not return a research brief in the expected format.')
		expect(adapter.calls.researcher).toHaveLength(0)
		expect(out.costCents).toBeGreaterThan(0)
	})

	it('makes no model call when the cap is too low for the lead', async () => {
		const adapter = routedAdapter({})
		const out = await runResearch({
			...base,
			effort: 'comparison',
			capCents: 1,
			adapter,
			search: fakeSearch(),
		})
		expect(adapter.chat).not.toHaveBeenCalled()
		expect(out.status).toBe('failed')
		expect(out.error).toContain('cap is too low for the lead')
		expect(out.costCents).toBe(0)
	})

	it('carries on when one researcher fails, and ends capped with a warning naming its subtopic', async () => {
		const adapter = routedAdapter({
			lead: () => leadReply(2),
			researcher: (ctx) => {
				if (ctx.topic === 'Topic 1') throw new Error('overloaded')
				return standardResearcher(ctx)
			},
		})
		const out = await runResearch({
			...base,
			effort: 'comparison',
			capCents: 400,
			adapter,
			search: fakeSearch(),
		})
		expect(out.status).toBe('capped')
		expect(out.warnings.join(' ')).toContain('Researcher 2 (Topic 1) stopped on an error')
		expect(out.reportMd?.startsWith('> **Warning:**')).toBe(true)
		expect(out.reportMd).toContain('Topic 1')
		expect(out.sources).toHaveLength(1)
	})

	it('fails when every researcher fails', async () => {
		const adapter = routedAdapter({
			researcher: () => {
				throw new Error('overloaded')
			},
		})
		const out = await runResearch({
			...base,
			effort: 'comparison',
			capCents: 400,
			adapter,
			search: fakeSearch(),
		})
		expect(out.status).toBe('failed')
		expect(out.error).toContain('overloaded')
	})

	it('reports spend as it goes', async () => {
		const seen: number[] = []
		const out = await runResearch({
			...base,
			effort: 'comparison',
			capCents: 400,
			adapter: routedAdapter({}),
			search: fakeSearch(),
			onProgress: (p) => seen.push(p.costCents),
		})
		expect(seen.length).toBeGreaterThan(3)
		expect([...seen].sort((a, b) => a - b)).toEqual(seen)
		expect(seen.at(-1)).toBe(out.costCents)
	})
})

describe('runResearch: the cap, the 85% line and the deadline', () => {
	it('runs 12 researchers, at most 5 at a time, each on its own share, and ends within 5% of the cap', async () => {
		let inFlight = 0
		let peak = 0
		const adapter = routedAdapter({
			lead: () => leadReply(12),
			researcher: async ({ options }) => {
				inFlight += 1
				peak = Math.max(peak, inFlight)
				await new Promise((resolve) => setTimeout(resolve, 1))
				inFlight -= 1
				// Searches until the budget says stop, then reports.
				return options.tools
					? toolReply('web_search', { query: `q ${options.messages.length}` })
					: noFindings()
			},
		})
		const out = await runResearch({
			...base,
			effort: 'broad',
			capCents: 100,
			adapter,
			search: fakeSearch(),
		})

		expect(out.researchers).toBe(12)
		expect(peak).toBe(5)
		expect(out.status).toBe('capped')
		expect(out.costCents).toBeGreaterThan(0)
		expect(out.costCents).toBeLessThanOrEqual(105)
		// 80% of 100 cents split 12 ways is 6.67 cents each, rounded up in the stage report.
		const researcherStages = Object.entries(out.stages).filter(([k]) => k.startsWith('researcher:'))
		expect(researcherStages).toHaveLength(12)
		for (const [, stage] of researcherStages) expect(stage.cost_cents).toBeLessThanOrEqual(7)
	})

	it('stops the other researchers at 85% of the cap and still runs the writer', async () => {
		const search = fakeSearch()
		const adapter = routedAdapter({
			lead: () => leadReply(3),
			researcher: ({ topic, options }) => {
				if (!options.tools) return noFindings()
				const reply = toolReply('web_search', { query: `q ${topic}` })
				// Topic 0's first call is billed at 90 cents: 90% of the run is spent.
				if (topic === 'Topic 0') {
					return {
						...reply,
						usage: {
							input_tokens: 900_000,
							output_tokens: 0,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
						},
					}
				}
				return reply
			},
		})
		const out = await runResearch({
			...base,
			effort: 'comparison',
			capCents: 100,
			adapter,
			search,
		})

		// The other two researchers made their in-flight search and no more.
		expect(search.search.mock.calls.length).toBeLessThanOrEqual(2)
		expect(adapter.calls.writer).toHaveLength(1)
		expect(out.status).toBe('capped')
		expect(out.warnings[0]).toContain('cost cap')
		expect(out.reportMd?.startsWith('> **Warning:**')).toBe(true)
	})

	it('stops unfinished researchers at the deadline, still runs the writer and ends capped', async () => {
		let t = 0
		const adapter = routedAdapter({
			lead: () => leadReply(2),
			researcher: ({ options }) => {
				if (!options.tools) return noFindings()
				t = 21 * 60 * 1000
				return toolReply('web_search', { query: 'slow topic' })
			},
		})
		const out = await runResearch({
			...base,
			effort: 'comparison',
			capCents: 400,
			adapter,
			search: fakeSearch(),
			now: () => t,
		})
		expect(adapter.calls.writer).toHaveLength(1)
		expect(out.status).toBe('capped')
		expect(out.warnings[0]).toContain('20 minute limit')
		expect(out.reportMd).toContain('ran out of time')
	})
})

describe('runResearch: ledger checks', () => {
	it('drops a finding with a made-up quote and one from a denylisted domain, and passes the denylist to the provider', async () => {
		const farm = 'https://blog.usecarly.com/best-tools-2026'
		const search = fakeSearch()
		const adapter = routedAdapter({
			researcher: ({ turn }) => {
				if (turn === 0) return toolReply('web_search', { query: 'vat rates' })
				if (turn === 1) return toolReply('web_fetch', { urls: [docUrl(0), farm] })
				return textReply(
					JSON.stringify({
						findings: [
							findingFor(0),
							findingFor(0, { quote: 'The rate is 99 percent for everyone.' }),
							findingFor(0, { url: farm }),
						],
						unread: [],
						gaps: [],
					}),
				)
			},
		})
		const out = await runResearch({
			...base,
			effort: 'simple',
			capCents: 100,
			adapter,
			search,
		})
		expect((out.findings as unknown[]).length).toBe(1)
		expect(out.warnings).toContain(
			'Findings dropped: 1 with a quote not found on the page, 1 from a blocked source.',
		)
		expect(search.search).toHaveBeenCalledWith(
			expect.objectContaining({ excludeDomains: expect.arrayContaining(['usecarly.com']) }),
		)
	})

	it('strips a citation that is not in the ledger from the final report', async () => {
		const adapter = routedAdapter({
			writer: () => textReply('## TL;DR\nThe rate is 25 percent [1] and 30 percent [9].'),
		})
		const out = await runResearch({
			...base,
			effort: 'simple',
			capCents: 100,
			adapter,
			search: fakeSearch(),
		})
		expect(out.reportMd).not.toContain('[9]')
		expect(out.warnings).toContain('Removed 1 citation(s) that point at no source in the ledger.')
	})

	it('reports the share of tier 1 and 2 sources in the Method section', async () => {
		const out = await runResearch({
			...base,
			effort: 'simple',
			capCents: 100,
			adapter: routedAdapter({}),
			search: fakeSearch(),
		})
		expect(out.tier12Share).toBe(1)
		expect(out.reportMd).toContain('Tier 1 and 2 sources: 100% of 1')
	})
})

describe('runResearch: the query scrub', () => {
	const names = createQueryScrub(['Acme Byg'])

	it('refuses a query with a workspace name on the simple path: the provider is not called and nothing is spent on it', async () => {
		const search = fakeSearch()
		const adapter = routedAdapter({
			researcher: ({ turn }) =>
				turn === 0 ? toolReply('web_search', { query: 'tilbud fra Acme Byg' }) : noFindings(),
		})
		const out = await runResearch({
			...base,
			effort: 'simple',
			scrub: names,
			capCents: 100,
			adapter,
			search,
		})
		expect(search.search).toHaveBeenCalledTimes(0)
		expect(out.searches).toBe(0)
		expect(out.scrubRejections).toBe(1)
		// The researcher is told why, in the words of the spec, without the name.
		const toolMessage = adapter.calls.researcher[1]?.messages.at(-1)
		expect(toolMessage?.role).toBe('tool')
		expect(toolMessage?.content).toBe(SCRUB_REJECTION_MESSAGE)
	})

	it('lets a public-topic query through once the researcher rewrites it, and counts the refusal in the Method section only as a number', async () => {
		const search = fakeSearch()
		const adapter = routedAdapter({
			researcher: ({ turn }) => {
				if (turn === 0) return toolReply('web_search', { query: 'Acme Byg moms' })
				if (turn === 1) return toolReply('web_search', { query: 'danish construction vat rules' })
				return noFindings()
			},
		})
		const out = await runResearch({
			...base,
			effort: 'simple',
			scrub: names,
			capCents: 100,
			adapter,
			search,
		})
		expect(search.search).toHaveBeenCalledTimes(1)
		expect(search.search.mock.calls[0]?.[0].query).toBe('danish construction vat rules')
		expect(out.searches).toBe(1)
		expect(out.reportMd).toContain('Searches refused by the workspace-name check: 1')
		expect(out.reportMd).not.toContain('Acme')
		expect(JSON.stringify(out)).not.toContain('Acme')
	})

	it('stops a researcher after 3 refused queries with a gap, and the run still reaches the writer', async () => {
		const search = fakeSearch()
		const adapter = routedAdapter({
			lead: () => leadReply(2),
			researcher: (ctx) => {
				if (ctx.topic !== 'Topic 0') return standardResearcher(ctx)
				return ctx.options.tools
					? toolReply('web_search', { query: `Acme Byg offer ${ctx.turn}` })
					: noFindings()
			},
		})
		const out = await runResearch({
			...base,
			effort: 'comparison',
			scrub: names,
			capCents: 400,
			adapter,
			search,
		})

		expect(out.scrubRejections).toBe(3)
		// Only the other researcher's search reached the provider.
		expect(search.search).toHaveBeenCalledTimes(1)
		expect(adapter.calls.writer).toHaveLength(1)
		expect(adapter.calls.writer[0]?.messages[1]?.content).toContain(
			'Stopped after 3 rejected search queries',
		)
		expect(out.warnings.join(' ')).toContain('refused by the workspace-name check')
		expect(out.reportMd).toContain('Searches refused by the workspace-name check: 3')
		expect(out.sources).toHaveLength(1)
	})
})
