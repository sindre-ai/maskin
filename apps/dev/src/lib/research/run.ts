import type { LLMAdapter, LLMMessage, LLMResponse } from '../llm/adapter'
import { logger } from '../logger'
import type { ModelPricing } from '../openrouter-pricing'
import type { ResearchEffort } from '../research-cap'
import { type BudgetStage, RunBudget, worstCaseLlmMicroUsd } from './budget'
import { EFFORT_PLANS, MAX_PARALLEL_RESEARCHERS, type ResearchBrief, parseLeadBrief } from './lead'
import {
	type Ledger,
	type LedgerPart,
	type LedgerSource,
	type UnreadSource,
	buildMergedLedger,
	buildMethodSection,
	estimateTokens,
	fitFindings,
	postCheckReport,
	tier12Share,
} from './ledger'
import {
	LEAD_SYSTEM_PROMPT,
	WRITER_SYSTEM_PROMPT,
	leadUserPrompt,
	renderLedgerFinding,
	researcherUserPrompt,
	subtopicUserPrompt,
	writerUserPrompt,
} from './prompts'
import { FatalRunError, type ResearcherResult, runResearcher } from './researcher'
import { type QueryScrub, withQueryScrub } from './scrub'
import type { ResearchSearchProvider } from './search-provider'
import { RESEARCH_DOMAIN_DENYLIST } from './source-quality'

/**
 * One deep_research run (spec 7.1): an optional lead call that writes the brief,
 * researchers in parallel (one for simple effort, up to five at a time otherwise),
 * the ledger, exactly one writer call, and the report post-check. No database in
 * here: the caller hands in the model adapter, the search provider and the clock,
 * so the cap behaviour is testable without a network.
 */

/** Tool calls the single researcher of a simple run may make (spec 7.2). */
export const SIMPLE_MAX_TOOL_CALLS = 10
const LEAD_MAX_TOKENS = 3_000
const WRITER_MAX_TOKENS = 4_000
/** Below this the writer would cut off mid-report, so the ledger is listed instead. */
const WRITER_MIN_OUTPUT_TOKENS = 600
const WRITER_MAX_INPUT_TOKENS = 12_000
const MODEL_CALL_TIMEOUT_MS = 120_000
/** Run deadline, 20 minutes (spec 7.3). */
export const RUN_DEADLINE_MS = 20 * 60 * 1000

export interface RunProgress {
	costCents: number
	tokensIn: number
	tokensOut: number
	searches: number
	extracts: number
}

export interface ResearchRunInput {
	effort: ResearchEffort
	question: string
	context: string | null
	capCents: number
	adapter: LLMAdapter
	model: string
	pricing: ModelPricing
	search: ResearchSearchProvider
	/**
	 * The workspace-name check (spec 7.9). Required, and applied here around the
	 * provider, so no effort level can reach the provider without it.
	 */
	scrub: QueryScrub
	/** Called after every cost, so the caller can save spend as it goes. */
	onProgress?: (progress: RunProgress) => void
	/** Test seams. */
	now?: () => number
	deadlineMs?: number
	denylist?: readonly string[]
}

export type ResearchRunStatus = 'done' | 'capped' | 'failed'

export interface ResearchRunOutcome {
	status: ResearchRunStatus
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
	/** Searches the workspace-name check refused. A count only. */
	scrubRejections: number
	error: string | null
}

export async function runResearch(input: ResearchRunInput): Promise<ResearchRunOutcome> {
	const now = input.now ?? Date.now
	const startedAt = now()
	const deadline = startedAt + (input.deadlineMs ?? RUN_DEADLINE_MS)
	const denylist = input.denylist ?? RESEARCH_DOMAIN_DENYLIST
	const plan = EFFORT_PLANS[input.effort]
	const hasLead = input.effort !== 'simple'
	const search = withQueryScrub(input.search, input.scrub)
	const warnings: string[] = []
	const stages: ResearchRunOutcome['stages'] = {}
	let tokensIn = 0
	let tokensOut = 0
	let researcherCount = hasLead ? 0 : 1
	let scrubRejections = 0

	const budget = new RunBudget({
		capCents: input.capCents,
		researchers: plan.minResearchers,
		hasLead,
		onSpend: () =>
			input.onProgress?.({
				costCents: budget.spentCents,
				tokensIn,
				tokensOut,
				searches: budget.searchCount,
				extracts: budget.extractCount,
			}),
	})

	let brief: ResearchBrief = {
		interpretation: input.question,
		subtopics: [
			{
				objective: input.question,
				sub_questions: [input.question],
				source_hints: [],
				boundaries: '',
				tool_call_limit: SIMPLE_MAX_TOOL_CALLS,
			},
		],
	}

	const finish = (
		partial: Pick<ResearchRunOutcome, 'status' | 'reportMd' | 'sources' | 'findings' | 'error'>,
	): ResearchRunOutcome => ({
		...partial,
		warnings,
		brief,
		stages,
		costCents: budget.spentCents,
		tokensIn,
		tokensOut,
		searches: budget.searchCount,
		extracts: budget.extractCount,
		researchers: researcherCount,
		tier12Share: tier12Share(partial.sources),
		scrubRejections,
		error: partial.error,
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
		tokensIn +=
			res.usage.input_tokens +
			res.usage.cache_read_input_tokens +
			res.usage.cache_creation_input_tokens
		tokensOut += res.usage.output_tokens
		budget.recordLlm(stage, res.usage, input.pricing)
		return res
	}

	const execute = async (): Promise<ResearchRunOutcome> => {
		// ── Lead ────────────────────────────────────────────────────────────────
		if (hasLead) {
			const leadStart = now()
			const messages: LLMMessage[] = [
				{ role: 'system', content: LEAD_SYSTEM_PROMPT },
				{
					role: 'user',
					content: leadUserPrompt({
						question: input.question,
						context: input.context,
						minSubtopics: plan.minResearchers,
						maxSubtopics: plan.maxResearchers,
						maxToolCalls: plan.maxToolCalls,
					}),
				},
			]
			const worst = worstCaseLlmMicroUsd(
				estimateTokens(messages.map((m) => m.content).join('\n')),
				LEAD_MAX_TOKENS,
				input.pricing,
			)
			if (!budget.canAfford('lead', worst)) {
				return finish({
					status: 'failed',
					reportMd: null,
					sources: [],
					findings: [],
					error:
						'The cap is too low for the lead call that plans this research. Raise the cap or use simple effort.',
				})
			}
			let reply: string | null
			try {
				reply = (await chat('lead', { model: input.model, messages, max_tokens: LEAD_MAX_TOKENS }))
					.content
			} catch (err) {
				if (!(err instanceof FatalRunError)) throw err
				stages.lead = stageInfo(budget, 'lead', leadStart, now())
				return finish({
					status: 'failed',
					reportMd: null,
					sources: [],
					findings: [],
					error: err.message,
				})
			}
			stages.lead = stageInfo(budget, 'lead', leadStart, now())
			const parsed = parseLeadBrief(reply, plan)
			if (parsed === null) {
				return finish({
					status: 'failed',
					reportMd: null,
					sources: [],
					findings: [],
					error: 'The lead did not return a research brief in the expected format.',
				})
			}
			brief = parsed
			researcherCount = brief.subtopics.length
			budget.assignResearchers(researcherCount)
		}

		// ── Researchers ─────────────────────────────────────────────────────────
		const results = await runPool(
			brief.subtopics,
			MAX_PARALLEL_RESEARCHERS,
			(subtopic, i): Promise<ResearcherResult> =>
				runResearcher({
					stage: `researcher:${i}`,
					userPrompt: hasLead
						? subtopicUserPrompt({
								question: input.question,
								context: input.context,
								interpretation: brief.interpretation,
								subtopic,
							})
						: researcherUserPrompt(input.question, input.context),
					toolCallLimit: subtopic.tool_call_limit,
					budget,
					pricing: input.pricing,
					model: input.model,
					search,
					denylist,
					deadline,
					now,
					chat,
				}),
		)
		results.forEach((r, i) => {
			stages[hasLead ? `researcher:${i}` : 'researcher'] = stageInfo(
				budget,
				`researcher:${i}`,
				r.startedAt,
				r.endedAt,
			)
			scrubRejections += r.scrubRejections
		})

		const usable = results.filter((r) => r.output !== null)
		if (usable.length === 0) {
			return finish({
				status: 'failed',
				reportMd: null,
				sources: [],
				findings: [],
				error: results[0]?.failure ?? 'The researchers returned nothing.',
			})
		}
		results.forEach((r, i) => {
			if (r.output === null && hasLead) {
				warnings.push(
					`Researcher ${i + 1} (${brief.subtopics[i]?.objective ?? 'a subtopic'}) stopped on an error: ${r.failure}`,
				)
			}
			warnings.push(...r.warnings)
			if (r.stoppedByScrub) {
				warnings.push(
					'A researcher stopped after repeated search queries were refused by the workspace-name check.',
				)
			}
		})

		const gaps = usable.flatMap((r) => r.output?.gaps ?? [])
		const unread: UnreadSource[] = results.flatMap((r) => [
			...r.unread,
			...(r.output?.unread ?? []),
		])
		const queries = results.flatMap((r) => r.queries)
		const fetchedUrls = new Set(results.flatMap((r) => [...r.fetchedText.keys()]))
		const stoppedFor = stopReason(results)
		const failedResearchers = results.length - usable.length

		const parts: LedgerPart[] = usable.map((r) => ({
			output: r.output as NonNullable<ResearcherResult['output']>,
			fetchedText: r.fetchedText,
		}))
		const ledger = buildMergedLedger(parts, denylist)
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
				gaps,
				interpretation: hasLead ? brief.interpretation : undefined,
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
		const capped = stoppedFor !== null || writerCut || failedResearchers > 0
		if (stoppedFor !== null || writerCut) {
			warnings.unshift(
				stoppedFor === 'deadline'
					? 'The run hit its 20 minute limit before the research was finished.'
					: 'The run reached its cost cap before the research was finished.',
			)
		}
		const thinAreas = [
			...(hasLead
				? results.flatMap((r, i) =>
						r.stoppedFor !== null || r.output === null
							? [brief.subtopics[i]?.objective ?? 'a subtopic']
							: [],
					)
				: []),
			...gaps,
		]
		const reportMd = [
			capped
				? cappedWarning(stoppedFor ?? (writerCut ? 'budget' : 'error'), thinAreas, input.question)
				: '',
			checked.markdown,
			sourcesSection(ledger.sources),
			buildMethodSection({
				effort: input.effort,
				researchers: researcherCount,
				queries,
				sourcesRead: fetchedUrls.size,
				unread,
				costCents: budget.spentCents,
				capCents: input.capCents,
				tier12Share: tier12Share(ledger.sources),
				sourceCount: ledger.sources.length,
				scrubRejections,
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

/** Runs `fn` over `items` with at most `limit` in flight. Results keep the order of `items`. */
async function runPool<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length)
	let next = 0
	const worker = async () => {
		while (next < items.length) {
			const i = next++
			results[i] = await fn(items[i] as T, i)
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
	return results
}

/** Deadline outranks budget when researchers stopped for both. */
function stopReason(results: readonly ResearcherResult[]): 'budget' | 'deadline' | null {
	if (results.some((r) => r.stoppedFor === 'deadline')) return 'deadline'
	if (results.some((r) => r.stoppedFor === 'budget')) return 'budget'
	return null
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout>
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms)
	})
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
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

function cappedWarning(
	stoppedFor: 'budget' | 'deadline' | 'error',
	thinAreas: string[],
	question: string,
) {
	const why =
		stoppedFor === 'deadline'
			? 'ran out of time'
			: stoppedFor === 'budget'
				? 'reached its cost cap'
				: 'lost part of its research to an error'
	const thin =
		thinAreas.length > 0
			? thinAreas.join('; ')
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
