import type { LLMMessage, LLMResponse, LLMToolCall } from '../llm/adapter'
import type { ModelPricing } from '../openrouter-pricing'
import { type BudgetStage, type RunBudget, worstCaseLlmMicroUsd } from './budget'
import {
	type ResearcherOutput,
	type UnreadSource,
	estimateTokens,
	normalizeUrl,
	parseResearcherOutput,
} from './ledger'
import { RESEARCHER_SYSTEM_PROMPT, RESEARCHER_TOOLS, RESEARCHER_WRAP_UP_MESSAGE } from './prompts'
import { MAX_SCRUB_REJECTIONS_PER_RESEARCHER, QueryRejectedError } from './scrub'
import { ResearchProviderError, type ResearchSearchProvider } from './search-provider'

/**
 * One researcher (spec 7.1 step 3, 7.4): loops model call, then web_search or
 * web_fetch, until it has enough or hits its tool-call limit, its budget share or
 * the deadline, then returns structured findings. Simple effort runs one of
 * these; comparison and broad run up to five at a time. No database in here.
 */

/** A tool-using turn is short; the final JSON reply gets more room. */
const TURN_MAX_TOKENS = 1_024
const FINAL_MAX_TOKENS = 4_096
/** Room in the wrap-up reservation for the tool results the next turn adds. */
const TOOL_RESULT_PAD_TOKENS = 3_000
const MAX_FETCH_URLS_PER_CALL = 3
/** What the researcher sees of one page; the quote check runs on the full text. */
const PAGE_TEXT_MODEL_CHARS = 8_000
const MAX_SEARCH_HITS_SHOWN = 8
const SNIPPET_CHARS = 300

/** A failure that ends this researcher and carries a plain reason. */
export class FatalRunError extends Error {}

export interface ResearcherInput {
	stage: BudgetStage
	/** The first user message: the question, or a subtopic of it. */
	userPrompt: string
	toolCallLimit: number
	budget: RunBudget
	pricing: ModelPricing
	model: string
	search: ResearchSearchProvider
	denylist: readonly string[]
	deadline: number
	now: () => number
	/** One metered model call; throws FatalRunError when the call fails. */
	chat: (
		stage: BudgetStage,
		options: {
			model: string
			messages: LLMMessage[]
			tools?: typeof RESEARCHER_TOOLS
			max_tokens: number
		},
	) => Promise<LLMResponse>
}

export interface ResearcherResult {
	/** Null when there was no usable reply: see `failure`. */
	output: ResearcherOutput | null
	failure: string | null
	fetchedText: Map<string, string>
	queries: string[]
	unread: UnreadSource[]
	stoppedFor: 'budget' | 'deadline' | null
	/** Searches the scrub refused. Never the names they matched. */
	scrubRejections: number
	/** True when the researcher was stopped by the scrub after too many rejections. */
	stoppedByScrub: boolean
	startedAt: number
	endedAt: number
	/** Notes for the run's warnings. */
	warnings: string[]
}

export async function runResearcher(input: ResearcherInput): Promise<ResearcherResult> {
	const { budget, stage, search, pricing } = input
	const startedAt = input.now()
	const messages: LLMMessage[] = [
		{ role: 'system', content: RESEARCHER_SYSTEM_PROMPT },
		{ role: 'user', content: input.userPrompt },
	]
	const queries: string[] = []
	const unread: UnreadSource[] = []
	const fetchedText = new Map<string, string>()
	const warnings: string[] = []
	let stoppedFor = null as 'budget' | 'deadline' | null
	let toolCalls = 0
	let scrubRejections = 0
	let stoppedByScrub = false
	let finalReply: string | null = null

	const worstCase = (msgs: LLMMessage[], maxTokens: number, padTokens = 0): number =>
		worstCaseLlmMicroUsd(
			estimateTokens(msgs.map((m) => m.content).join('\n')) + padTokens,
			maxTokens,
			pricing,
		)

	/** What the final reply could cost, reserved before any tool call so it always fits. */
	const wrapUpReserve = () => worstCase(messages, FINAL_MAX_TOKENS, TOOL_RESULT_PAD_TOKENS)

	const runTool = async (call: LLMToolCall): Promise<string> => {
		if (call.name === 'web_search') {
			const query = typeof call.arguments.query === 'string' ? call.arguments.query.trim() : ''
			if (!query) return 'Error: web_search needs a non-empty query.'
			if (!budget.canAfford(stage, search.searchPriceMicroUsd + wrapUpReserve())) {
				stoppedFor = 'budget'
				return 'Budget used up: no more searches. Return your JSON findings now.'
			}
			try {
				const result = await search.search({
					query,
					excludeDomains: input.denylist.length > 0 ? [...input.denylist] : undefined,
					boostDenmark: call.arguments.denmark === true,
				})
				budget.recordSearch(stage, result.costMicroUsd)
				queries.push(query)
				if (result.hits.length === 0) return 'No results.'
				return result.hits
					.slice(0, MAX_SEARCH_HITS_SHOWN)
					.map(
						(h, i) =>
							`${i + 1}. ${h.title} <${h.url}> (${h.publishedDate ?? 'undated'})\n   ${h.snippet.slice(0, SNIPPET_CHARS)}`,
					)
					.join('\n')
			} catch (err) {
				if (err instanceof QueryRejectedError) {
					scrubRejections += 1
					if (scrubRejections >= MAX_SCRUB_REJECTIONS_PER_RESEARCHER) {
						stoppedByScrub = true
						return `${err.message} That was your last allowed rejected query: stop now and return your JSON findings.`
					}
					return err.message
				}
				return providerFailure(err, 'Search')
			}
		}
		if (call.name === 'web_fetch') {
			const requested = Array.isArray(call.arguments.urls)
				? call.arguments.urls.filter((u): u is string => typeof u === 'string')
				: []
			const urls = requested.slice(0, MAX_FETCH_URLS_PER_CALL)
			if (urls.length === 0) return 'Error: web_fetch needs at least one URL.'
			const price = urls.length * search.extractUrlPriceMicroUsd
			if (!budget.canAfford(stage, price + wrapUpReserve())) {
				stoppedFor = 'budget'
				return 'Budget used up: no more page reads. Return your JSON findings now.'
			}
			try {
				const result = await search.extract(urls)
				budget.recordExtract(stage, result.costMicroUsd, result.pages.length)
				for (const f of result.failed) unread.push({ url: f.url, reason: f.reason })
				for (const p of result.pages) fetchedText.set(normalizeUrl(p.url), p.text)
				const blocks = result.pages.map(
					(p) => `<page url="${p.url}">\n${p.text.slice(0, PAGE_TEXT_MODEL_CHARS)}\n</page>`,
				)
				const failures = result.failed.map((f) => `Could not read ${f.url}: ${f.reason}`)
				return [...blocks, ...failures].join('\n\n') || 'No pages returned.'
			} catch (err) {
				return providerFailure(err, 'Page read')
			}
		}
		return `Error: unknown tool ${call.name}.`
	}

	const finish = (output: ResearcherOutput | null, failure: string | null): ResearcherResult => ({
		output,
		failure,
		fetchedText,
		queries,
		unread,
		stoppedFor,
		scrubRejections,
		stoppedByScrub,
		startedAt,
		endedAt: input.now(),
		warnings,
	})

	try {
		while (true) {
			if (input.now() >= input.deadline) {
				stoppedFor = 'deadline'
				break
			}
			if (
				stoppedFor ||
				stoppedByScrub ||
				budget.researchExhausted ||
				toolCalls >= input.toolCallLimit
			) {
				if (!stoppedFor && !stoppedByScrub && budget.researchExhausted) stoppedFor = 'budget'
				break
			}
			const turnWorst = worstCase(messages, TURN_MAX_TOKENS)
			if (!budget.canAfford(stage, turnWorst + wrapUpReserve())) {
				stoppedFor = 'budget'
				break
			}
			const res = await input.chat(stage, {
				model: input.model,
				messages,
				tools: RESEARCHER_TOOLS,
				max_tokens: TURN_MAX_TOKENS,
			})
			if (res.tool_calls.length === 0) {
				finalReply = res.content
				break
			}
			// Calls past the limit are answered, not run, so the history stays valid.
			const calls = res.tool_calls
			messages.push({ role: 'assistant', content: res.content ?? '', tool_calls: calls })
			for (const call of calls) {
				const result =
					toolCalls < input.toolCallLimit && !stoppedByScrub
						? await runTool(call)
						: 'Tool call limit reached. Return your JSON findings now.'
				toolCalls += 1
				messages.push({ role: 'tool', content: result, tool_call_id: call.id })
			}
		}

		if (finalReply === null && toolCalls === 0 && stoppedFor) {
			// Stopped before it did anything: a wrap-up call would only pay for an empty reply.
			const why = stoppedFor === 'deadline' ? 'time ran out' : 'the budget ran out'
			return finish(
				{
					findings: [],
					unread: [],
					gaps: [`Not researched: ${why} before this part was started.`],
					malformedFindings: 0,
				},
				null,
			)
		}
		if (finalReply === null) {
			messages.push({ role: 'user', content: RESEARCHER_WRAP_UP_MESSAGE })
			if (budget.canAfford(stage, worstCase(messages, FINAL_MAX_TOKENS))) {
				finalReply = (
					await input.chat(stage, {
						model: input.model,
						messages,
						max_tokens: FINAL_MAX_TOKENS,
					})
				).content
			} else {
				stoppedFor = stoppedFor ?? 'budget'
				warnings.push('The budget ran out before a researcher could report what it found.')
			}
		}
	} catch (err) {
		if (!(err instanceof FatalRunError)) throw err
		return finish(null, err.message)
	}

	const output =
		finalReply === null
			? { findings: [], unread: [], gaps: [], malformedFindings: 0 }
			: parseResearcherOutput(finalReply)
	if (output === null) {
		return finish(null, 'The researcher did not return findings in the expected format.')
	}
	if (stoppedByScrub) {
		output.gaps.push(
			`Stopped after ${MAX_SCRUB_REJECTIONS_PER_RESEARCHER} rejected search queries: this part may need names that cannot be searched.`,
		)
	}
	return finish(output, null)
}

function providerFailure(err: unknown, what: string): string {
	if (err instanceof ResearchProviderError) {
		// A rejected key or a bad request will not get better on a retry: end the run.
		if (!err.retryable) throw new FatalRunError(`${what} failed: ${err.message}`)
		return `${what} failed (${err.message}). Try something else or return your findings.`
	}
	throw err
}
