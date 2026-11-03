import type { Database } from '@maskin/db'
import { actors, researchRuns, sessions, workspaceMembers, workspaces } from '@maskin/db/schema'
import { parseResultLine } from '@maskin/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { captureResearchRunFinished } from '../lib/analytics/research-events'
import { isEnterprise } from '../lib/enterprise'
import { ApiErrorCode } from '../lib/errors'
import { LLM_ROUTE_CUSTOM, ceilCents } from '../lib/llm-routing'
import { logger } from '../lib/logger'
import { type ModelPricing, getModelPricing } from '../lib/openrouter-pricing'
import { type ResearchEffort, resolveResearchRunCapCents } from '../lib/research-cap'
import type { WorkspaceSettings } from '../lib/types'
import { TERMINAL_STATUSES, startSession } from './session-lifecycle'
import type { SessionManager } from './session-manager'
import { readSessionStdoutChunks, resolveSessionCostUsd } from './usage-parser'

/**
 * Starts deep_research runs (spec r5.1 section 3). A run is one session of the
 * workspace's research agent, which carries the deep-research-subagents skill, pinned to
 * the workspace's custom model endpoint. The run row is created first and a
 * background watcher fills it from the session when it ends; the caller polls
 * GET /api/research/:id. The report is the last result message in the session
 * logs, the same read the create_session wait uses.
 */

const POLL_INTERVAL_MS = 3_000
/** A run that has not ended by then is stopped (spec 7.6). */
const RUN_DEADLINE_MS = 20 * 60 * 1000
/** How long a stopped session gets to settle before the run is closed without its result. */
const STOP_GRACE_MS = 60 * 1000

/**
 * The CLI budget flag is set to this share of the run cap (CTO decision, spec r5.1 section 4):
 * requests in flight when the flag trips still bill, so the stop has to come before the cap.
 */
const BUDGET_FLAG_SHARE = 0.85
/** Turn limit for the research session. ASSUMED: recalibrate after the skill's dry run. */
const RESEARCH_MAX_TURNS = 60

/**
 * OpenRouter bills each Web Search request on top of the tokens. Measured on 3 Nov 2026 from the
 * key's usage counter: $0.00700 and $0.00702 for one search each, after pricing the tokens at the
 * catalogue rate. The CLI's own total_cost_usd leaves the fee out and prices the model at ~3x.
 */
const WEB_SEARCH_USD = 0.007

const MAX_RUNS_PER_WORKSPACE = 2
const DEFAULT_MAX_CONCURRENT_RUNS = 4

/** The research agent is the agent member of the workspace marked with this metadata key. */
const RESEARCH_AGENT_METADATA_KEY = 'deep_research_agent'

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
	sessionManager: Pick<SessionManager, 'stopSession'>
	actorId: string
	workspaceId: string
	question: string
	context: string | null
	effort: ResearchEffort
	maxCostUsd?: number
}

/** Seams for tests: the session start, the price, the env and the timings. */
export interface ResearchDeps {
	startSession?: (input: Parameters<typeof startSession>[0]) => Promise<{ sessionId: string }>
	lookupPricing?: (model: string) => Promise<ModelPricing | null>
	env?: NodeJS.ProcessEnv
	pollIntervalMs?: number
	deadlineMs?: number
	stopGraceMs?: number
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

export const NEEDS_CUSTOM_ENDPOINT_MESSAGE =
	'Deep research needs a custom model endpoint saved and enabled on this workspace (Settings, Keys). A Claude subscription or Anthropic API key alone cannot run it.'

export const NO_RESEARCH_AGENT_MESSAGE =
	'Deep research is not set up for this workspace yet: it has no research agent.'

/** The research agent of a workspace: an agent member marked with the deep_research_agent metadata key. */
async function findResearchAgentId(db: Database, workspaceId: string): Promise<string | null> {
	const [row] = await db
		.select({ id: actors.id })
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(actors.type, 'agent'),
				sql`${actors.metadata}->>${RESEARCH_AGENT_METADATA_KEY} = 'true'`,
			),
		)
		.limit(1)
	return row?.id ?? null
}

/**
 * Checks everything a run needs (a custom endpoint, a priced model, a research
 * agent, the cap) and only then creates the row and starts the session. Nothing
 * is spent and no row exists if any check fails.
 */
export async function startResearchRun(
	params: StartResearchParams,
	deps: ResearchDeps = {},
): Promise<{ id: string; status: string }> {
	const env = deps.env ?? process.env
	const { db, workspaceId, actorId } = params

	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	if (!ws) throw new ResearchStartError(400, ApiErrorCode.BAD_REQUEST, 'Workspace not found.')
	const wsSettings = (ws.settings as WorkspaceSettings) ?? {}

	// The session is pinned to this endpoint (see resolveLlmRoute pinRoute), so it is also
	// the model the run is priced on. Custom endpoints are a BYO entitlement.
	const custom = wsSettings.custom_llm
	const model = custom?.model?.trim()
	if (
		!isEnterprise(ws) ||
		!custom?.enabled ||
		!custom.base_url?.trim() ||
		!custom.api_key ||
		!model
	) {
		throw new ResearchStartError(400, ApiErrorCode.BAD_REQUEST, NEEDS_CUSTOM_ENDPOINT_MESSAGE)
	}

	// No unmetered runs: a model with no price refuses to start.
	const pricing = await (deps.lookupPricing ?? getModelPricing)(model)
	if (!pricing) {
		throw new ResearchStartError(
			400,
			ApiErrorCode.BAD_REQUEST,
			`Deep research cannot run on the model ${model}: it has no price, so the cost cannot be capped.`,
		)
	}

	const agentId = await findResearchAgentId(db, workspaceId)
	if (!agentId) {
		throw new ResearchStartError(503, ApiErrorCode.INTERNAL_ERROR, NO_RESEARCH_AGENT_MESSAGE)
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
				llmRoute: LLM_ROUTE_CUSTOM,
				model,
			})
			.returning({ id: researchRuns.id })
		if (!row) throw new Error('research_runs insert returned no row')
		runId = row.id
	} catch (err) {
		releaseSlot(workspaceId)
		throw err
	}

	let sessionId: string
	try {
		const started = await (deps.startSession ?? startSession)({
			workspaceId,
			actorId: agentId,
			callerKind: 'internal',
			createdBy: actorId,
			actionPrompt: buildResearchPrompt(params),
			// The pin keeps this session off every other route; the run id ties it back to its row.
			config: {
				pin_llm_route: LLM_ROUTE_CUSTOM,
				research_run_id: runId,
				runtime_config: {
					max_turns: RESEARCH_MAX_TURNS,
					max_budget_usd: budgetFlagUsd(capCents),
				},
			},
			initiatedFromObjectId: null,
		})
		sessionId = started.sessionId
		await db.update(researchRuns).set({ sessionId }).where(eq(researchRuns.id, runId))
	} catch (err) {
		// Nothing ran, so no row stays behind.
		await db
			.delete(researchRuns)
			.where(eq(researchRuns.id, runId))
			.catch(() => undefined)
		releaseSlot(workspaceId)
		throw err
	}

	void watchRun({
		db,
		sessionManager: params.sessionManager,
		runId,
		sessionId,
		actorId,
		workspaceId,
		effort: params.effort,
		capCents,
		deps,
	}).finally(() => {
		releaseSlot(workspaceId)
		deps.onRunSettled?.(runId)
	})

	return { id: runId, status: 'queued' }
}

/** The amount the CLI budget flag gets for a run cap, in USD. */
export function budgetFlagUsd(capCents: number): number {
	return Math.max(0.0001, Number(((capCents / 100) * BUDGET_FLAG_SHARE).toFixed(4)))
}

/** What the research agent is asked. The skill carries the method; this carries the question. */
function buildResearchPrompt(p: StartResearchParams): string {
	return [
		'Use the deep-research-subagents skill to answer the question below.',
		`Effort: ${p.effort}.`,
		`Question: ${p.question}`,
		p.context ? `Context: ${p.context}` : null,
		'Your final message is the finished report, with a Sources section at the end.',
	]
		.filter(Boolean)
		.join('\n')
}

interface WatchArgs {
	db: Database
	sessionManager: Pick<SessionManager, 'stopSession'>
	runId: string
	sessionId: string
	actorId: string
	workspaceId: string
	effort: ResearchEffort
	capCents: number
	deps: ResearchDeps
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Follows the session to its end, stops it at the deadline, then fills the run. Never throws. */
async function watchRun(a: WatchArgs): Promise<void> {
	const pollMs = a.deps.pollIntervalMs ?? POLL_INTERVAL_MS
	const startedAt = new Date()
	const deadline = startedAt.getTime() + (a.deps.deadlineMs ?? RUN_DEADLINE_MS)
	let stopRequestedAt: number | null = null
	let markedRunning = false
	let session: typeof sessions.$inferSelect | undefined
	let timedOut = false

	try {
		while (true) {
			const [row] = await a.db.select().from(sessions).where(eq(sessions.id, a.sessionId)).limit(1)
			session = row
			if (!row) break
			if ((TERMINAL_STATUSES as readonly string[]).includes(row.status)) break

			if (!markedRunning && row.status === 'running') {
				markedRunning = true
				await a.db
					.update(researchRuns)
					.set({ status: 'running', startedAt })
					.where(eq(researchRuns.id, a.runId))
			}

			const now = Date.now()
			if (stopRequestedAt === null && now > deadline) {
				timedOut = true
				stopRequestedAt = now
				await a.sessionManager.stopSession(a.sessionId).catch((err) =>
					logger.error('deep_research: could not stop the session at the deadline', {
						runId: a.runId,
						sessionId: a.sessionId,
						error: String(err),
					}),
				)
			} else if (
				stopRequestedAt !== null &&
				now - stopRequestedAt > (a.deps.stopGraceMs ?? STOP_GRACE_MS)
			) {
				break
			}
			await sleep(pollMs)
		}
	} catch (err) {
		logger.error('deep_research: could not follow the session', {
			runId: a.runId,
			sessionId: a.sessionId,
			error: String(err),
		})
	}

	const finishedAt = new Date()
	let update: Partial<typeof researchRuns.$inferInsert>
	try {
		update = await outcomeOf(a, session, timedOut)
	} catch (err) {
		logger.error('deep_research: could not read the session result', {
			runId: a.runId,
			sessionId: a.sessionId,
			error: String(err),
		})
		update = { status: 'failed', error: 'The run stopped on an unexpected error.' }
	}

	try {
		await a.db
			.update(researchRuns)
			.set({ ...update, finishedAt })
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
		status: update.status === 'done' || update.status === 'capped' ? update.status : 'failed',
		costCents: update.costCents ?? 0,
		capCents: a.capCents,
		duration: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
		route: LLM_ROUTE_CUSTOM,
		model: session?.modelName ?? null,
	})
}

/** The run columns that follow from how the session ended. */
async function outcomeOf(
	a: WatchArgs,
	session: typeof sessions.$inferSelect | undefined,
	timedOut: boolean,
): Promise<Partial<typeof researchRuns.$inferInsert>> {
	if (!session) return { status: 'failed', error: 'The research session could not be found.' }

	const chunks = await readSessionStdoutChunks(a.db, a.sessionId)
	const result = lastResult(chunks)
	const usage = await sessionUsage(session, result, a.deps.lookupPricing ?? getModelPricing)

	const base = { ...usage, ...(session.modelName ? { model: session.modelName } : {}) }
	if (timedOut) {
		return { ...base, status: 'failed', error: 'The run was stopped at its 20 minute limit.' }
	}
	// The CLI exits non-zero when a limit trips, so this is checked before the session status.
	const limit = result ? limitHit(result.subtype) : null
	if (limit) {
		const warning = limitWarning(limit, a.capCents)
		const partial = lastAssistantText(chunks)
		const reportMd = `> **Warning:** ${warning}\n\n${partial || 'No findings were written before the run stopped.'}`
		return {
			...base,
			status: 'capped',
			reportMd,
			sources: parseSources(partial),
			warnings: [{ code: limit, message: warning }],
			error: null,
		}
	}
	if (session.status !== 'completed') {
		const failure = (session.result as { failure_reason?: { human_message?: string } } | null)
			?.failure_reason?.human_message
		return {
			...base,
			status: 'failed',
			error: failure ?? `The research session ended as ${session.status}.`,
		}
	}
	if (!result || result.isError || !result.text.trim()) {
		return {
			...base,
			status: 'failed',
			error: result?.text.trim() || 'The research session ended without a report.',
		}
	}
	return {
		...base,
		status: 'done',
		reportMd: result.text,
		sources: parseSources(result.text),
		error: null,
	}
}

type LimitHit = 'cost_cap_reached' | 'turn_limit_reached'

/** Which limit ended the run, from the CLI result subtype. */
function limitHit(subtype: string | null): LimitHit | null {
	if (subtype === 'error_max_budget_usd') return 'cost_cap_reached'
	if (subtype === 'error_max_turns') return 'turn_limit_reached'
	return null
}

function limitWarning(limit: LimitHit, capCents: number): string {
	return limit === 'cost_cap_reached'
		? `This run stopped at its cost cap of $${(capCents / 100).toFixed(2)} before it finished, so the report is partial.`
		: 'This run stopped at its turn limit before it finished, so the report is partial.'
}

/** The text of the last top-level assistant message that has any, or '' when there is none. */
function lastAssistantText(chunks: string[]): string {
	const lines = chunks.join('').split('\n')
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = (lines[i] ?? '').trim()
		if (!line.startsWith('{')) continue
		let msg: { type?: string; parent_tool_use_id?: unknown; message?: { content?: unknown } }
		try {
			msg = JSON.parse(line)
		} catch {
			continue
		}
		if (msg.type !== 'assistant' || msg.parent_tool_use_id != null) continue
		const content = msg.message?.content
		if (!Array.isArray(content)) continue
		const text = content
			.map((b: { type?: string; text?: string }) => (b.type === 'text' ? (b.text ?? '') : ''))
			.join('')
			.trim()
		if (text) return text
	}
	return ''
}

/** The last top-level result message in the stdout chunks, or null when there is none. */
function lastResult(chunks: string[]): ReturnType<typeof parseResultLine> {
	const lines = chunks.join('').split('\n')
	for (let i = lines.length - 1; i >= 0; i--) {
		const result = parseResultLine(lines[i] ?? '')
		if (result) return result
	}
	return null
}

/**
 * Cost and tokens of the run. The result message's per-model usage covers the whole run, the
 * searches' own model calls included, and is priced at the catalogue rate plus the search fee: that
 * is what OpenRouter bills. Its top-level usage and the session's stamped cost count only part of
 * the calls, so they are the fallback for a result without per-model usage or with an unpriced model.
 */
async function sessionUsage(
	session: typeof sessions.$inferSelect,
	result: ReturnType<typeof parseResultLine>,
	lookupPricing: (model: string) => Promise<ModelPricing | null>,
): Promise<Pick<typeof researchRuns.$inferInsert, 'costCents' | 'tokensIn' | 'tokensOut'>> {
	const whole = await wholeRunUsage(result?.raw, lookupPricing)
	if (whole) {
		return {
			costCents: ceilCents(whole.costUsd * 100),
			tokensIn: whole.tokensIn,
			tokensOut: whole.tokensOut,
		}
	}

	const usage = result?.usage
	let costUsd = session.totalCostUsd === null ? null : Number(session.totalCostUsd)
	if (costUsd === null && usage) {
		costUsd = await resolveSessionCostUsd({
			route: LLM_ROUTE_CUSTOM,
			modelName: session.modelName,
			usage,
		})
	}
	return {
		costCents: costUsd !== null && Number.isFinite(costUsd) ? ceilCents(costUsd * 100) : 0,
		tokensIn: session.inputTokens ?? usage?.inputTokens ?? 0,
		tokensOut: session.outputTokens ?? usage?.outputTokens ?? 0,
	}
}

interface ModelUsageEntry {
	inputTokens?: number
	outputTokens?: number
	cacheReadInputTokens?: number
	cacheCreationInputTokens?: number
	webSearchRequests?: number
}

/** Cost and tokens from the result's modelUsage, or null when it is missing or has an unpriced model. */
async function wholeRunUsage(
	raw: string | undefined,
	lookupPricing: (model: string) => Promise<ModelPricing | null>,
): Promise<{ costUsd: number; tokensIn: number; tokensOut: number } | null> {
	if (!raw) return null
	let modelUsage: Record<string, ModelUsageEntry> | undefined
	try {
		modelUsage = (JSON.parse(raw) as { modelUsage?: Record<string, ModelUsageEntry> }).modelUsage
	} catch {
		return null
	}
	const entries = modelUsage ? Object.entries(modelUsage) : []
	if (entries.length === 0) return null

	let costUsd = 0
	let tokensIn = 0
	let tokensOut = 0
	for (const [model, u] of entries) {
		const pricing = await lookupPricing(model)
		if (!pricing) return null
		costUsd +=
			(u.inputTokens ?? 0) * pricing.prompt +
			(u.outputTokens ?? 0) * pricing.completion +
			(u.cacheReadInputTokens ?? 0) * pricing.cacheRead +
			(u.cacheCreationInputTokens ?? 0) * pricing.cacheWrite +
			(u.webSearchRequests ?? 0) * WEB_SEARCH_USD
		tokensIn += u.inputTokens ?? 0
		tokensOut += u.outputTokens ?? 0
	}
	return { costUsd, tokensIn, tokensOut }
}

export interface ResearchSource {
	n: number
	text: string
	url: string | null
}

/**
 * The numbered entries under the report's Sources heading, e.g. "[1] Title, Publisher, 2026-01-02.
 * https://example.com". Empty when the report has no such section.
 */
export function parseSources(reportMd: string): ResearchSource[] {
	const lines = reportMd.split('\n')
	const start = lines.findIndex((l) => /^#{1,6}\s*sources\s*$/i.test(l.trim()))
	if (start === -1) return []
	const sources: ResearchSource[] = []
	for (const line of lines.slice(start + 1)) {
		if (/^#{1,6}\s/.test(line.trim())) break
		const m = /^\s*(?:[-*]\s*)?\[?(\d+)[\].)]\s+(.+)$/.exec(line)
		if (!m) continue
		const text = (m[2] ?? '').trim()
		sources.push({ n: Number(m[1]), text, url: /https?:\/\/[^\s)>\]]+/.exec(text)?.[0] ?? null })
	}
	return sources
}

/**
 * A run is followed by this process, so a run still queued or running when the server starts
 * has no one watching it. Marks it interrupted, keeps the cost saved so far, and stops its
 * session so it cannot keep spending. There is no resume: the caller starts the run again.
 * Returns the number of runs marked.
 */
export async function markInterruptedResearchRuns(
	db: Database,
	sessionManager?: Pick<SessionManager, 'stopSession'>,
): Promise<number> {
	const rows = await db
		.update(researchRuns)
		.set({
			status: 'interrupted',
			error: 'The server restarted before this run finished. Start it again.',
			finishedAt: new Date(),
		})
		.where(inArray(researchRuns.status, ['queued', 'running']))
		.returning({ id: researchRuns.id, sessionId: researchRuns.sessionId })
	for (const row of rows) {
		if (!row.sessionId || !sessionManager) continue
		await sessionManager.stopSession(row.sessionId).catch((err) =>
			logger.warn('deep_research: could not stop the session of an interrupted run', {
				runId: row.id,
				sessionId: row.sessionId,
				error: String(err),
			}),
		)
	}
	return rows.length
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
	}
	cap: { cap_cents: number }
	route: string | null
	model: string | null
	session_id: string | null
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
		},
		cap: { cap_cents: row.capCents },
		route: row.llmRoute,
		model: row.model,
		session_id: row.sessionId,
		warnings: row.warnings ?? [],
		error: row.error,
		created_at: row.createdAt.toISOString(),
		finished_at: row.finishedAt ? row.finishedAt.toISOString() : null,
	}
}
