import type { Database } from '@maskin/db'
import { events, notifications, sessions, workspaces } from '@maskin/db/schema'
import type { HeadlineResponse } from '@maskin/shared'
import { and, eq, gte, inArray } from 'drizzle-orm'
import { createLLMAdapter } from '../lib/llm'
import { logger } from '../lib/logger'
import type { WorkspaceSettings } from '../lib/types'

const HEADLINE_TTL_MS = 5 * 60 * 1000
const LLM_TIMEOUT_MS = 3000
const HEADLINE_MAX_CHARS = 140

export interface HeadlineAggregate {
	workspaceName: string
	settings: WorkspaceSettings | null
	runningSessions: number
	pendingNotifications: number
	eventsLast24h: number
	uniqueAgentsLast24h: number
}

interface CachedHeadline {
	value: HeadlineResponse
	expiresAt: number
}

const cache = new Map<string, CachedHeadline>()

/**
 * Drop expired entries; called on every read to keep the map from growing
 * unbounded across long-lived processes. The map is small (one entry per
 * workspace) so a full sweep is cheaper than tracking eviction separately.
 */
function evictExpired(now: number): void {
	for (const [key, entry] of cache) {
		if (entry.expiresAt <= now) cache.delete(key)
	}
}

export function clearHeadlineCache(): void {
	cache.clear()
}

/**
 * Aggregate the inputs the headline composer needs: today's activity, the
 * roster engaged in it, and the queue of pending decisions. Runs the four
 * independent queries in parallel.
 */
async function aggregateHeadlineInputs(
	db: Database,
	workspaceId: string,
): Promise<HeadlineAggregate | null> {
	const since = new Date(Date.now() - 24 * 60 * 60 * 1000)

	const [wsRow, runningRows, pendingRows, recentEvents] = await Promise.all([
		db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1),
		db
			.select({ id: sessions.id })
			.from(sessions)
			.where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.status, 'running'))),
		db
			.select({ id: notifications.id })
			.from(notifications)
			.where(
				and(
					eq(notifications.workspaceId, workspaceId),
					inArray(notifications.status, ['pending', 'seen']),
				),
			),
		db
			.select({ actorId: events.actorId })
			.from(events)
			.where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, since))),
	])

	const ws = wsRow[0]
	if (!ws) return null

	const uniqueAgents = new Set<string>()
	for (const row of recentEvents) {
		if (row.actorId) uniqueAgents.add(row.actorId)
	}

	return {
		workspaceName: ws.name,
		settings: (ws.settings as WorkspaceSettings | null) ?? null,
		runningSessions: runningRows.length,
		pendingNotifications: pendingRows.length,
		eventsLast24h: recentEvents.length,
		uniqueAgentsLast24h: uniqueAgents.size,
	}
}

/**
 * Deterministic English sentence describing the workspace state. Mirrored on
 * the front end so the headline strip is never blank during fetch/error.
 *
 * Selection order (highest priority first):
 *   1. Pending decisions — captain action required
 *   2. Live sessions — agents shipping work
 *   3. Recent activity — quiet but not idle
 *   4. Idle — no signal at all
 *
 * Each branch returns a single sentence ≤140 chars, present tense, no markdown.
 */
export function buildFallbackHeadline(input: HeadlineAggregate): string {
	const { runningSessions, pendingNotifications, eventsLast24h, uniqueAgentsLast24h } = input

	if (pendingNotifications > 0) {
		const decisionWord = pendingNotifications === 1 ? 'decision is' : 'decisions are'
		if (runningSessions > 0) {
			const agentWord = runningSessions === 1 ? 'agent is' : 'agents are'
			return `${runningSessions} ${agentWord} working; ${pendingNotifications} ${decisionWord} waiting on you.`
		}
		return `${pendingNotifications} ${decisionWord} waiting on you.`
	}

	if (runningSessions > 0) {
		const agentWord = runningSessions === 1 ? 'agent is' : 'agents are'
		return `${runningSessions} ${agentWord} shipping work — nothing needs your call right now.`
	}

	if (eventsLast24h > 0) {
		const agentWord = uniqueAgentsLast24h === 1 ? 'agent' : 'agents'
		const count = uniqueAgentsLast24h || 1
		return `${count} ${agentWord} moved things forward today; the team is at rest now.`
	}

	return 'The team is at rest — no agents are working and nothing needs your call.'
}

export interface ResolvedLlm {
	provider: 'anthropic' | 'openai'
	apiKey: string
	model: string
}

/**
 * Pick the workspace's configured LLM credential, preferring Anthropic. Returns
 * null when no key is configured — the caller falls through to rule-based.
 */
function resolveLlm(settings: WorkspaceSettings | null): ResolvedLlm | null {
	const keys = settings?.llm_keys ?? {}
	if (keys.anthropic) {
		return { provider: 'anthropic', apiKey: keys.anthropic, model: 'claude-haiku-4-5-20251001' }
	}
	if (keys.openai) {
		return { provider: 'openai', apiKey: keys.openai, model: 'gpt-4o-mini' }
	}
	return null
}

const SYSTEM_PROMPT = [
	'You write a single short sentence describing the live state of an AI team.',
	'Hard rules:',
	'- Output exactly one sentence.',
	'- Present tense.',
	'- No markdown, no quotes, no preamble.',
	`- ≤${HEADLINE_MAX_CHARS} characters total.`,
	'- If the captain has nothing to decide, end the sentence calmly.',
	'- If a decision is waiting, name how many and end with a brief nudge.',
].join('\n')

function buildUserPrompt(input: HeadlineAggregate): string {
	return [
		`Workspace: ${input.workspaceName}`,
		`Agents currently working: ${input.runningSessions}`,
		`Pending decisions waiting on the human: ${input.pendingNotifications}`,
		`Events in last 24h: ${input.eventsLast24h}`,
		`Unique agents active in last 24h: ${input.uniqueAgentsLast24h}`,
	].join('\n')
}

function clampHeadline(raw: string): string {
	const collapsed = raw.replace(/\s+/g, ' ').trim()
	if (collapsed.length <= HEADLINE_MAX_CHARS) return collapsed
	return `${collapsed.slice(0, HEADLINE_MAX_CHARS - 1)}…`
}

/**
 * Race the LLM call against a hard 3s deadline. Anthropic/OpenAI adapters use
 * `fetch` without an AbortController, so this wrapper enforces the timeout via
 * Promise.race — on timeout the underlying fetch is left to settle (and its
 * result discarded).
 */
async function callLlmWithTimeout(
	resolved: ResolvedLlm,
	input: HeadlineAggregate,
): Promise<string | null> {
	const adapter = createLLMAdapter(resolved.provider, { api_key: resolved.apiKey })

	const completion = adapter.chat({
		model: resolved.model,
		messages: [
			{ role: 'system', content: SYSTEM_PROMPT },
			{ role: 'user', content: buildUserPrompt(input) },
		],
		temperature: 0.3,
	})

	const timeout = new Promise<null>((resolve) => {
		setTimeout(() => resolve(null), LLM_TIMEOUT_MS)
	})

	const result = await Promise.race([completion, timeout])
	if (result === null) return null
	return result.content
}

export interface BuildHeadlineDeps {
	now?: () => Date
	llm?: (resolved: ResolvedLlm, input: HeadlineAggregate) => Promise<string | null>
}

/**
 * Build (or return cached) headline for a workspace. Cache key buckets to a
 * 5-minute window so two requests inside the same window get an identical
 * payload — including `generatedAt`, which front-end clients use to tell
 * "fresh" from "served from cache".
 */
export async function buildHeadline(
	db: Database,
	workspaceId: string,
	deps: BuildHeadlineDeps = {},
): Promise<HeadlineResponse | null> {
	const now = (deps.now ?? (() => new Date()))()
	const nowMs = now.getTime()
	evictExpired(nowMs)

	const bucket = Math.floor(nowMs / HEADLINE_TTL_MS)
	const cacheKey = `${workspaceId}:${bucket}`
	const cached = cache.get(cacheKey)
	if (cached) return cached.value

	const aggregate = await aggregateHeadlineInputs(db, workspaceId)
	if (!aggregate) return null

	const fallbackText = buildFallbackHeadline(aggregate)
	const resolved = resolveLlm(aggregate.settings)

	let headlineText = fallbackText
	let source: 'llm' | 'fallback' = 'fallback'

	if (resolved) {
		try {
			const llmFn = deps.llm ?? callLlmWithTimeout
			const raw = await llmFn(resolved, aggregate)
			if (raw && raw.trim().length > 0) {
				headlineText = clampHeadline(raw)
				source = 'llm'
			}
		} catch (err) {
			logger.warn('Headline LLM call failed; using rule-based fallback', {
				workspaceId,
				error: String(err),
			})
		}
	}

	const response: HeadlineResponse = {
		headline: headlineText,
		generatedAt: now.toISOString(),
		source,
	}

	const ttl = HEADLINE_TTL_MS - (nowMs % HEADLINE_TTL_MS)
	cache.set(cacheKey, { value: response, expiresAt: nowMs + ttl })

	return response
}
