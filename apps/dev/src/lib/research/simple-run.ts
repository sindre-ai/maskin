import type { LLMAdapter, LLMMessage, LLMResponse, LLMToolCall } from '../llm/adapter'
import { logger } from '../logger'
import type { ModelPricing } from '../openrouter-pricing'
import { type BudgetStage, RunBudget, worstCaseLlmMicroUsd } from './budget'
import {
	type Ledger,
	type LedgerSource,
	type UnreadSource,
	buildLedger,
	buildMethodSection,
	estimateTokens,
	fitFindings,
	normalizeUrl,
	parseResearcherOutput,
	postCheckReport,
	tier12Share,
} from './ledger'
import {
	RESEARCHER_SYSTEM_PROMPT,
	RESEARCHER_TOOLS,
	RESEARCHER_WRAP_UP_MESSAGE,
	WRITER_SYSTEM_PROMPT,
	renderLedgerFinding,
	researcherUserPrompt,
	writerUserPrompt,
} from './prompts'
import { ResearchProviderError, type ResearchSearchProvider } from './search-provider'
import { RESEARCH_DOMAIN_DENYLIST } from './source-quality'

/**
 * One simple-effort run (spec 7.1 with the lead call skipped, 7.2, 7.3): one
 * researcher that loops model call then search or fetch, then exactly one writer
 * call. No database in here: the caller hands in the model adapter, the search
 * provider and the clock, so the cap behaviour is testable without a network.
 */

const RESEARCH_STAGE: BudgetStage = 'researcher:0'

/** Tool calls the single researcher may make (spec 7.2). */
export const SIMPLE_MAX_TOOL_CALLS = 10
/** A tool-using turn is short; the final JSON reply gets more room. */
const TURN_MAX_TOKENS = 1_024
const FINAL_MAX_TOKENS = 4_096
const WRITER_MAX_TOKENS = 4_000
/** Below this the writer would cut off mid-report, so the ledger is listed instead. */
const WRITER_MIN_OUTPUT_TOKENS = 600
const WRITER_MAX_INPUT_TOKENS = 12_000
/** Room in the wrap-up reservation for the tool results the next turn adds. */
const TOOL_RESULT_PAD_TOKENS = 3_000
const MAX_FETCH_URLS_PER_CALL = 3
/** What the researcher sees of one page; the quote check runs on the full text. */
const PAGE_TEXT_MODEL_CHARS = 8_000
const MAX_SEARCH_HITS_SHOWN = 8
const SNIPPET_CHARS = 300
const MODEL_CALL_TIMEOUT_MS = 120_000
/** Run deadline, 20 minutes (spec 7.3). */
export const RUN_DEADLINE_MS = 20 * 60 * 1000

export interface SimpleRunInput {
	question: string
	context: string | null
	capCents: number
	adapter: LLMAdapter
	model: string
	pricing: ModelPricing
	search: ResearchSearchProvider
	/** Test seams. */
	now?: () => number
	deadlineMs?: number
	denylist?: readonly string[]
}

export type SimpleRunStatus = 'done' | 'capped' | 'failed'

export interface SimpleRunOutcome {
	status: SimpleRunStatus
	reportMd: string | null
	sources: LedgerSource[]
	warnings: string[]
	brief: unknown
	/** The kept findings with their quotes. Deleted from the row after 30 days. */
	findings: unknown
	stages: Record<string, { cost_cents: number; seconds: number }>
	costCents: number
	tokensIn: number
	tokensOut: number
	searches: number
	extracts: number
	researchers: number
	tier12Share: number
	error: string | null
}

class FatalRunError extends Error {}

export async function runSimpleResearch(input: SimpleRunInput): Promise<SimpleRunOutcome> {
	const now = input.now ?? Date.now
	const startedAt = now()
	const deadline = startedAt + (input.deadlineMs ?? RUN_DEADLINE_MS)
	const denylist = input.denylist ?? RESEARCH_DOMAIN_DENYLIST
	const budget = new RunBudget({ capCents: input.capCents, researchers: 1, hasLead: false })
	const warnings: string[] = []
	const stages: SimpleRunOutcome['stages'] = {}
	let tokensIn = 0
	let tokensOut = 0

	const brief = {
		interpretation: input.question,
		subtopics: [
			{
				objective: input.question,
				sub_questions: [input.question],
				tool_call_limit: SIMPLE_MAX_TOOL_CALLS,
			},
		],
	}

	const finish = (
		partial: Pick<SimpleRunOutcome, 'status' | 'reportMd' | 'sources' | 'findings' | 'error'>,
	): SimpleRunOutcome => ({
		...partial,
		warnings,
		brief,
		stages,
		costCents: budget.spentCents,
		tokensIn,
		tokensOut,
		searches: budget.searchCount,
		extracts: budget.extractCount,
		researchers: 1,
		tier12Share: tier12Share(partial.sources),
	})

	const chat = async (
		stage: BudgetStage,
		options: Parameters<LLMAdapter['chat']>[0],
	): Promise<LLMResponse> => {
		let res: LLMResponse
		try {
			// The adapters have no timeout of their own, so a hung provider would hold the run open.
			res = await withTimeout(input.adapter.chat(options), MODEL_CALL_TIMEOUT_MS)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			throw new FatalRunError(`The model call failed: ${msg.slice(0, 300)}`)
		}
		budget.recordLlm(stage, res.usage, input.pricing)
		tokensIn +=
			res.usage.input_tokens +
			res.usage.cache_read_input_tokens +
			res.usage.cache_creation_input_tokens
		tokensOut += res.usage.output_tokens
		return res
	}

	const worstCase = (messages: LLMMessage[], maxTokens: number, padTokens = 0): number =>
		worstCaseLlmMicroUsd(
			estimateTokens(messages.map((m) => m.content).join('\n')) + padTokens,
			maxTokens,
			input.pricing,
		)

	const execute = async (): Promise<SimpleRunOutcome> => {
		// ── Researcher ──────────────────────────────────────────────────────────
		const researchStart = now()
		const messages: LLMMessage[] = [
			{ role: 'system', content: RESEARCHER_SYSTEM_PROMPT },
			{ role: 'user', content: researcherUserPrompt(input.question, input.context) },
		]
		const queries: string[] = []
		const unread: UnreadSource[] = []
		const fetchedText = new Map<string, string>()
		let stoppedFor = null as 'budget' | 'deadline' | null
		let toolCalls = 0
		let finalReply: string | null = null

		/** What the final reply could cost, reserved before any tool call so it always fits. */
		const wrapUpReserve = () => worstCase(messages, FINAL_MAX_TOKENS, TOOL_RESULT_PAD_TOKENS)

		const runTool = async (call: LLMToolCall): Promise<string> => {
			if (call.name === 'web_search') {
				const query = typeof call.arguments.query === 'string' ? call.arguments.query.trim() : ''
				if (!query) return 'Error: web_search needs a non-empty query.'
				if (!budget.canAfford(RESEARCH_STAGE, input.search.searchPriceMicroUsd + wrapUpReserve())) {
					stoppedFor = 'budget'
					return 'Budget used up: no more searches. Return your JSON findings now.'
				}
				try {
					const result = await input.search.search({
						query,
						excludeDomains: denylist.length > 0 ? [...denylist] : undefined,
						boostDenmark: call.arguments.denmark === true,
					})
					budget.recordSearch(RESEARCH_STAGE, result.costMicroUsd)
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
					return providerFailure(err, 'Search')
				}
			}
			if (call.name === 'web_fetch') {
				const requested = Array.isArray(call.arguments.urls)
					? call.arguments.urls.filter((u): u is string => typeof u === 'string')
					: []
				const urls = requested.slice(0, MAX_FETCH_URLS_PER_CALL)
				if (urls.length === 0) return 'Error: web_fetch needs at least one URL.'
				const price = urls.length * input.search.extractUrlPriceMicroUsd
				if (!budget.canAfford(RESEARCH_STAGE, price + wrapUpReserve())) {
					stoppedFor = 'budget'
					return 'Budget used up: no more page reads. Return your JSON findings now.'
				}
				try {
					const result = await input.search.extract(urls)
					budget.recordExtract(RESEARCH_STAGE, result.costMicroUsd, result.pages.length)
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

		try {
			while (true) {
				if (now() >= deadline) {
					stoppedFor = 'deadline'
					break
				}
				if (stoppedFor || budget.researchExhausted || toolCalls >= SIMPLE_MAX_TOOL_CALLS) {
					if (!stoppedFor && budget.researchExhausted) stoppedFor = 'budget'
					break
				}
				const turnWorst = worstCase(messages, TURN_MAX_TOKENS)
				if (!budget.canAfford(RESEARCH_STAGE, turnWorst + wrapUpReserve())) {
					stoppedFor = 'budget'
					break
				}
				const res = await chat(RESEARCH_STAGE, {
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
						toolCalls < SIMPLE_MAX_TOOL_CALLS
							? await runTool(call)
							: 'Tool call limit reached. Return your JSON findings now.'
					toolCalls += 1
					messages.push({ role: 'tool', content: result, tool_call_id: call.id })
				}
			}

			if (finalReply === null) {
				messages.push({ role: 'user', content: RESEARCHER_WRAP_UP_MESSAGE })
				if (budget.canAfford(RESEARCH_STAGE, worstCase(messages, FINAL_MAX_TOKENS))) {
					finalReply = (
						await chat(RESEARCH_STAGE, {
							model: input.model,
							messages,
							max_tokens: FINAL_MAX_TOKENS,
						})
					).content
				} else {
					stoppedFor = stoppedFor ?? 'budget'
					warnings.push('The budget ran out before the researcher could report what it found.')
				}
			}
		} catch (err) {
			if (!(err instanceof FatalRunError)) throw err
			stages.researcher = stageInfo(budget, RESEARCH_STAGE, researchStart, now())
			return finish({
				status: 'failed',
				reportMd: null,
				sources: [],
				findings: [],
				error: err.message,
			})
		}
		stages.researcher = stageInfo(budget, RESEARCH_STAGE, researchStart, now())

		const output =
			finalReply === null
				? { findings: [], unread: [], gaps: [], malformedFindings: 0 }
				: parseResearcherOutput(finalReply)
		if (output === null) {
			return finish({
				status: 'failed',
				reportMd: null,
				sources: [],
				findings: [],
				error: 'The researcher did not return findings in the expected format.',
			})
		}
		for (const u of output.unread) unread.push(u)

		const ledger = buildLedger(output, fetchedText, denylist)
		noteDroppedFindings(ledger, warnings)

		// ── Writer ──────────────────────────────────────────────────────────────
		const writerStart = now()
		const writerRemaining = budget.remainingMicroUsd('writer')
		const promptPrice = input.pricing.prompt * 1_000_000
		const completionPrice = input.pricing.completion * 1_000_000
		const outputRoom = (inputTokens: number): number =>
			completionPrice > 0
				? Math.floor((writerRemaining - inputTokens * promptPrice) / completionPrice)
				: WRITER_MAX_TOKENS
		const fixedInputTokens = estimateTokens(WRITER_SYSTEM_PROMPT) + 200
		const inputRoom =
			promptPrice > 0
				? Math.floor((writerRemaining - WRITER_MIN_OUTPUT_TOKENS * completionPrice) / promptPrice)
				: WRITER_MAX_INPUT_TOKENS
		const ledgerRoom = Math.min(WRITER_MAX_INPUT_TOKENS, inputRoom) - fixedInputTokens

		let reportBody: string | null = null
		let writerCut = false
		let findings = ledger.findings
		if (ledgerRoom > 0) {
			findings = fitFindings(ledger.findings, ledgerRoom, renderLedgerFinding)
			if (findings.length < ledger.findings.length) {
				warnings.push(
					`${ledger.findings.length - findings.length} low-confidence finding(s) left out of the report to fit the budget.`,
				)
			}
			const userPrompt = writerUserPrompt({
				question: input.question,
				context: input.context,
				sources: ledger.sources,
				findings,
				gaps: output.gaps,
			})
			const maxTokens = Math.min(
				WRITER_MAX_TOKENS,
				outputRoom(estimateTokens(userPrompt) + fixedInputTokens),
			)
			if (maxTokens >= WRITER_MIN_OUTPUT_TOKENS) {
				try {
					const res = await chat('writer', {
						model: input.model,
						messages: [
							{ role: 'system', content: WRITER_SYSTEM_PROMPT },
							{ role: 'user', content: userPrompt },
						],
						max_tokens: maxTokens,
					})
					reportBody = res.content?.trim() || null
					writerCut = maxTokens < WRITER_MAX_TOKENS && res.usage.output_tokens >= maxTokens * 0.98
				} catch (err) {
					if (!(err instanceof FatalRunError)) throw err
					stages.writer = stageInfo(budget, 'writer', writerStart, now())
					return finish({
						status: 'failed',
						reportMd: null,
						sources: ledger.sources,
						findings: ledger.findings,
						error: err.message,
					})
				}
			}
		}
		if (reportBody === null) {
			warnings.push(
				'The budget did not leave room for the writer, so the findings are listed as they were found.',
			)
			reportBody = listFindings(ledger)
			writerCut = true
		}
		stages.writer = stageInfo(budget, 'writer', writerStart, now())

		// ── Post-check and assembly ─────────────────────────────────────────────
		const checked = postCheckReport(reportBody, ledger.sources)
		warnings.push(...checked.warnings)
		const capped = stoppedFor !== null || writerCut
		if (capped) {
			warnings.unshift(
				stoppedFor === 'deadline'
					? 'The run hit its 20 minute limit before the research was finished.'
					: 'The run reached its cost cap before the research was finished.',
			)
		}
		const reportMd = [
			capped ? cappedWarning(stoppedFor, output.gaps, input.question) : '',
			checked.markdown,
			sourcesSection(ledger.sources),
			buildMethodSection({
				effort: 'simple',
				researchers: 1,
				queries,
				sourcesRead: fetchedText.size,
				unread,
				costCents: budget.spentCents,
				capCents: input.capCents,
			}),
		]
			.filter(Boolean)
			.join('\n\n')

		return finish({
			status: capped ? 'capped' : 'done',
			reportMd,
			sources: ledger.sources,
			findings: ledger.findings,
			error: null,
		})
	}

	try {
		return await execute()
	} catch (err) {
		// Whatever was spent before the failure still counts against the plan cap.
		logger.error('deep_research run failed unexpectedly', { error: String(err) })
		return finish({
			status: 'failed',
			reportMd: null,
			sources: [],
			findings: [],
			error: err instanceof FatalRunError ? err.message : 'The run stopped on an unexpected error.',
		})
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout>
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms)
	})
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function providerFailure(err: unknown, what: string): string {
	if (err instanceof ResearchProviderError) {
		// A rejected key or a bad request will not get better on a retry: end the run.
		if (!err.retryable) throw new FatalRunError(`${what} failed: ${err.message}`)
		return `${what} failed (${err.message}). Try something else or return your findings.`
	}
	throw err
}

function stageInfo(budget: RunBudget, stage: BudgetStage, from: number, to: number) {
	return {
		cost_cents: budget.stageCostCents()[stage] ?? 0,
		seconds: Math.max(0, Math.round((to - from) / 1000)),
	}
}

function noteDroppedFindings(ledger: Ledger, warnings: string[]) {
	const d = ledger.dropped
	const parts = [
		d.quoteNotFound && `${d.quoteNotFound} with a quote not found on the page`,
		d.notFetched && `${d.notFetched} from a page that was never read`,
		d.blocked && `${d.blocked} from a blocked source`,
		d.malformed && `${d.malformed} in the wrong format`,
	].filter(Boolean)
	if (parts.length > 0) warnings.push(`Findings dropped: ${parts.join(', ')}.`)
}

function cappedWarning(stoppedFor: 'budget' | 'deadline' | null, gaps: string[], question: string) {
	const why = stoppedFor === 'deadline' ? 'ran out of time' : 'reached its cost cap'
	const thin =
		gaps.length > 0
			? gaps.join('; ')
			: `the whole question ("${question}") may be only partly covered`
	return `> **Warning:** this run ${why} before it finished, so the research is incomplete. Thin areas: ${thin}.`
}

function listFindings(ledger: Ledger): string {
	if (ledger.findings.length === 0)
		return '## Key findings\n\nNo source found for this question within the budget.'
	return `## Key findings\n\n${ledger.findings.map((f) => `- ${f.claim} [${f.n}]`).join('\n')}`
}

function sourcesSection(sources: readonly LedgerSource[]): string {
	if (sources.length === 0) return ''
	const lines = sources.map((s) => {
		const meta = [s.publisher, s.date, s.source_type].filter(Boolean).join(', ')
		return `[${s.n}] ${s.title} (${meta}) ${s.url}`
	})
	return `## Sources\n\n${lines.join('\n')}`
}
