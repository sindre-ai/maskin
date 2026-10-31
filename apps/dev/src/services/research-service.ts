import type { Database } from '@maskin/db'
import { researchRuns, workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { captureResearchRunFinished } from '../lib/analytics/research-events'
import { isEnterprise } from '../lib/enterprise'
import { ApiErrorCode } from '../lib/errors'
import { resolveChatCredentials } from '../lib/llm-routing'
import type { LLMAdapter } from '../lib/llm/adapter'
import { createLLMAdapter } from '../lib/llm/index'
import { logger } from '../lib/logger'
import type { ModelPricing } from '../lib/openrouter-pricing'
import { type ResearchEffort, resolveResearchRunCapCents } from '../lib/research-cap'
import { UnpricedModelError, requireModelPricing } from '../lib/research/budget'
import { lookupResearchModelPricing, researchRouteOf } from '../lib/research/model'
import { ResearchProviderError, type ResearchSearchProvider } from '../lib/research/search-provider'
import { type SimpleRunOutcome, runSimpleResearch } from '../lib/research/simple-run'
import { tavilyProviderFromEnv } from '../lib/research/tavily'
import type { WorkspaceSettings } from '../lib/types'

/**
 * Starts and runs deep_research runs inside the API process (spec 7.1, 7.6, 9).
 * The row is created first and the run continues in the background; the caller
 * polls GET /api/research/:id. Runs live in this process: a restart loses them.
 */

/** Efforts a run can be started with. Comparison and broad come with the lead call. */
export const STARTABLE_EFFORTS: readonly ResearchEffort[] = ['simple']

const MAX_RUNS_PER_WORKSPACE = 2
const DEFAULT_MAX_CONCURRENT_RUNS = 4

/** A request the caller can fix or must be told about, with the status the route answers. */
export class ResearchStartError extends Error {
	constructor(
		readonly status: 400 | 403 | 429 | 503,
		readonly code: ApiErrorCode,
		message: string,
	) {
		super(message)
		this.name = 'ResearchStartError'
	}
}

export interface StartResearchParams {
	db: Database
	actorId: string
	workspaceId: string
	question: string
	context: string | null
	effort: ResearchEffort
	maxCostUsd?: number
}

/** Seams for tests: the model adapter, the price, the search provider and the env. */
export interface ResearchDeps {
	createAdapter?: (credentials: {
		provider: string
		apiKey: string
		baseUrl?: string
		providerPrefs?: unknown
	}) => LLMAdapter
	lookupPricing?: (
		model: string,
		provider: 'anthropic' | 'openai' | 'ollama',
	) => Promise<ModelPricing | null>
	searchProvider?: () => ResearchSearchProvider
	env?: NodeJS.ProcessEnv
	/** Awaited by tests; the route leaves the run in the background. */
	onRunSettled?: (runId: string) => void
}

// In-process concurrency (spec 7.6): per workspace and per server.
const runsByWorkspace = new Map<string, number>()
let runsInProcess = 0

function maxConcurrentRuns(env: NodeJS.ProcessEnv): number {
	const n = Number(env.RESEARCH_MAX_CONCURRENT_RUNS)
	return env.RESEARCH_MAX_CONCURRENT_RUNS?.trim() && Number.isInteger(n) && n > 0
		? n
		: DEFAULT_MAX_CONCURRENT_RUNS
}

function claimSlot(workspaceId: string, env: NodeJS.ProcessEnv): void {
	if ((runsByWorkspace.get(workspaceId) ?? 0) >= MAX_RUNS_PER_WORKSPACE) {
		throw new ResearchStartError(
			429,
			ApiErrorCode.RATE_LIMITED,
			`This workspace already has ${MAX_RUNS_PER_WORKSPACE} research runs going. Wait for one to finish, or fetch it with its research_id.`,
		)
	}
	if (runsInProcess >= maxConcurrentRuns(env)) {
		throw new ResearchStartError(
			429,
			ApiErrorCode.RATE_LIMITED,
			'The server is busy with other research runs. Try again in a minute.',
		)
	}
	runsByWorkspace.set(workspaceId, (runsByWorkspace.get(workspaceId) ?? 0) + 1)
	runsInProcess += 1
}

function releaseSlot(workspaceId: string): void {
	const left = (runsByWorkspace.get(workspaceId) ?? 1) - 1
	if (left <= 0) runsByWorkspace.delete(workspaceId)
	else runsByWorkspace.set(workspaceId, left)
	runsInProcess = Math.max(0, runsInProcess - 1)
}

/** Test-only: forget claimed slots. */
export function __resetResearchSlotsForTesting(): void {
	runsByWorkspace.clear()
	runsInProcess = 0
}

export const NEEDS_API_KEY_MESSAGE =
	'Deep research needs an Anthropic API key or a custom model endpoint saved on this workspace. A Claude subscription alone cannot run it. Add a key under Settings, then try again.'

/**
 * Checks everything a run needs (credentials, a priced model, a search provider,
 * the cap) and only then creates the row and starts the work. Nothing is spent
 * and no row exists if any check fails.
 */
export async function startResearchRun(
	params: StartResearchParams,
	deps: ResearchDeps = {},
): Promise<{ id: string; status: string }> {
	const env = deps.env ?? process.env
	const { db, workspaceId, actorId } = params

	if (!STARTABLE_EFFORTS.includes(params.effort)) {
		throw new ResearchStartError(
			400,
			ApiErrorCode.BAD_REQUEST,
			`Effort "${params.effort}" is not available yet. Use "simple".`,
		)
	}

	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	if (!ws) throw new ResearchStartError(400, ApiErrorCode.BAD_REQUEST, 'Workspace not found.')
	const wsSettings = (ws.settings as WorkspaceSettings) ?? {}

	const credentials = resolveChatCredentials({
		wsSettings,
		agent: { provider: null, apiKey: null, model: null },
		workspace: { enterpriseGranted: ws.enterpriseGranted, billingOwnerId: ws.billingOwnerId },
	})
	if (!credentials)
		throw new ResearchStartError(400, ApiErrorCode.BAD_REQUEST, NEEDS_API_KEY_MESSAGE)

	// No unmetered runs: a model with no price refuses to start.
	let pricing: ModelPricing
	try {
		const lookup = deps.lookupPricing ?? lookupResearchModelPricing
		pricing = requireModelPricing(
			credentials.model,
			await lookup(credentials.model, credentials.provider),
		)
	} catch (err) {
		if (err instanceof UnpricedModelError) {
			throw new ResearchStartError(
				400,
				ApiErrorCode.BAD_REQUEST,
				`Deep research cannot run on the model ${credentials.model}: it has no price, so the cost cannot be capped.`,
			)
		}
		throw err
	}

	let search: ResearchSearchProvider
	try {
		search = (deps.searchProvider ?? (() => tavilyProviderFromEnv(env)))()
	} catch (err) {
		if (!(err instanceof ResearchProviderError)) throw err
		logger.error('deep_research: search provider is not configured', { error: err.message })
		throw new ResearchStartError(
			503,
			ApiErrorCode.INTERNAL_ERROR,
			'Deep research search is not set up on this server yet.',
		)
	}

	// Throws PlanCapExceededError (the 402 sessions return) when the plan has no headroom.
	const capCents = await resolveResearchRunCapCents({
		db,
		workspaceId,
		wsSettings,
		enterprise: isEnterprise(ws),
		effort: params.effort,
		callerMaxCostUsd: params.maxCostUsd,
		env,
	})

	claimSlot(workspaceId, env)
	let runId: string
	try {
		const [row] = await db
			.insert(researchRuns)
			.values({
				workspaceId,
				actorId,
				question: params.question,
				context: params.context,
				effort: params.effort,
				status: 'queued',
				capCents,
				llmRoute: researchRouteOf(credentials, wsSettings),
				model: credentials.model,
			})
			.returning({ id: researchRuns.id })
		if (!row) throw new Error('research_runs insert returned no row')
		runId = row.id
	} catch (err) {
		releaseSlot(workspaceId)
		throw err
	}

	const adapter = (
		deps.createAdapter ??
		((c) =>
			createLLMAdapter(c.provider, {
				api_key: c.apiKey,
				base_url: c.baseUrl,
				extra_body: c.providerPrefs && { provider: c.providerPrefs },
			}))
	)(credentials)

	void executeRun({
		db,
		runId,
		actorId,
		workspaceId,
		question: params.question,
		context: params.context,
		effort: params.effort,
		capCents,
		model: credentials.model,
		pricing,
		adapter,
		search,
	}).finally(() => {
		releaseSlot(workspaceId)
		deps.onRunSettled?.(runId)
	})

	return { id: runId, status: 'queued' }
}

interface ExecuteArgs {
	db: Database
	runId: string
	actorId: string
	workspaceId: string
	question: string
	context: string | null
	effort: ResearchEffort
	capCents: number
	model: string
	pricing: ModelPricing
	adapter: LLMAdapter
	search: ResearchSearchProvider
}

/** Runs one research run to its end, saves it, and fires the finished event once. Never throws. */
async function executeRun(a: ExecuteArgs): Promise<void> {
	const startedAt = new Date()
	let outcome: SimpleRunOutcome | null = null
	try {
		await a.db
			.update(researchRuns)
			.set({ status: 'running', startedAt })
			.where(eq(researchRuns.id, a.runId))
		outcome = await runSimpleResearch({
			question: a.question,
			context: a.context,
			capCents: a.capCents,
			adapter: a.adapter,
			model: a.model,
			pricing: a.pricing,
			search: a.search,
		})
	} catch (err) {
		logger.error('deep_research: run crashed', { runId: a.runId, error: String(err) })
	}

	const finishedAt = new Date()
	const status = outcome?.status ?? 'failed'
	try {
		await a.db
			.update(researchRuns)
			.set({
				status,
				costCents: outcome?.costCents ?? 0,
				tokensIn: outcome?.tokensIn ?? 0,
				tokensOut: outcome?.tokensOut ?? 0,
				searches: outcome?.searches ?? 0,
				extracts: outcome?.extracts ?? 0,
				brief: outcome?.brief ?? null,
				findings: outcome?.findings ?? null,
				reportMd: outcome?.reportMd ?? null,
				sources: outcome?.sources ?? null,
				warnings: outcome?.warnings ?? null,
				stages: outcome?.stages ?? null,
				error: outcome ? outcome.error : 'The run stopped on an unexpected error.',
				finishedAt,
			})
			.where(eq(researchRuns.id, a.runId))
	} catch (err) {
		logger.error('deep_research: could not save the finished run', {
			runId: a.runId,
			error: String(err),
		})
	}

	await captureResearchRunFinished({
		actorId: a.actorId,
		workspaceId: a.workspaceId,
		effort: a.effort,
		status,
		costCents: outcome?.costCents ?? 0,
		capCents: a.capCents,
		searches: outcome?.searches ?? 0,
		extracts: outcome?.extracts ?? 0,
		duration: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
		researchers: outcome?.researchers ?? 1,
		tier12Share: outcome?.tier12Share ?? 0,
	})
}

export interface ResearchRunView {
	id: string
	status: string
	effort: string
	report_md: string | null
	sources: unknown
	usage: {
		cost_cents: number
		tokens_in: number
		tokens_out: number
		searches: number
		extracts: number
	}
	cap: { cap_cents: number }
	warnings: unknown
	error: string | null
	created_at: string
	finished_at: string | null
}

export function toResearchRunView(row: typeof researchRuns.$inferSelect): ResearchRunView {
	return {
		id: row.id,
		status: row.status,
		effort: row.effort,
		report_md: row.reportMd,
		sources: row.sources ?? [],
		usage: {
			cost_cents: row.costCents,
			tokens_in: row.tokensIn,
			tokens_out: row.tokensOut,
			searches: row.searches,
			extracts: row.extracts,
		},
		cap: { cap_cents: row.capCents },
		warnings: row.warnings ?? [],
		error: row.error,
		created_at: row.createdAt.toISOString(),
		finished_at: row.finishedAt ? row.finishedAt.toISOString() : null,
	}
}
