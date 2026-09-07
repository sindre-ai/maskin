import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { actors, workspaceMembers, workspaces } from '@maskin/db/schema'
import { CHIEF_OF_STAFF_DEFAULT, CHIEF_OF_STAFF_SYSTEM_PROMPT } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { createLLMAdapter } from '../lib/llm'
import { resolveChatCredentials } from '../lib/llm-routing'
import { logger } from '../lib/logger'
import type { WorkspaceSettings } from '../lib/types'
import { type BriefingFacts, collectBriefingFacts } from './workspace-briefing'

/** The agent every workspace had before the Chief of Staff shipped. */
const LEGACY_DEFAULT_AGENT_NAME = 'Workspace Coach'

/** Keeps the call small — the script is 120–200 words, so this is generous. */
const MAX_SCRIPT_TOKENS = 700

/**
 * Warmer than the relevance check's `0` (this is prose, and identical wording
 * every morning would read as canned), cool enough that the model stays on the
 * facts it was given.
 */
const SCRIPT_TEMPERATURE = 0.6

/**
 * Who actually wrote the script. Deliberately *not* a `'cache'` member: a
 * cached brief still has an author, and collapsing the two made an agent brief
 * and a fallback brief indistinguishable the moment either was cached. Whether
 * this response came from storage is the separate `cached` flag.
 */
export type SpokenBriefSource = 'agent' | 'fallback'

export interface SpokenBrief {
	workspaceId: string
	headline: string
	script: string
	mentionedIds: string[]
	generatedAt: string
	source: SpokenBriefSource
	/** True when this response was served from the day's cache rather than
	 *  written just now. Orthogonal to `source`. */
	cached: boolean
	/** The agent that wrote it, or null — including when an agent resolved but
	 *  never got to write, so the UI can never credit prose to someone who
	 *  didn't produce it. */
	agent: { id: string; name: string } | null
	model: string | null
}

/** Cached script for one workspace-day. `briefs/{workspaceId}/{YYYY-MM-DD}.json`. */
interface CachedBrief extends Omit<SpokenBrief, 'cached'> {
	inputHash: string
}

export function briefCacheKey(workspaceId: string, date: Date): string {
	return `briefs/${workspaceId}/${utcDateStamp(date)}.json`
}

/** UTC so the cache key and the daily sweep agree on where the day ends. */
export function utcDateStamp(date: Date): string {
	return date.toISOString().slice(0, 10)
}

/**
 * Who the script would be written by, as far as the cache is concerned.
 * Folded into the fingerprint alongside the facts because these are the other
 * two inputs to the prose — the system prompt is spliced into the request, and
 * the model decides what comes back.
 */
export interface BriefAuthorFingerprint {
	agentId: string | null
	systemPrompt: string | null
	model: string | null
}

/**
 * Stable fingerprint of everything the script is written from. A cached brief
 * is reused only while this matches, so a bet moving status regenerates the
 * brief the next time it's asked for — and nothing else does.
 *
 * `author` is part of it because the facts are not the only input. Editing the
 * Chief of Staff's system prompt in the UI, pinning a different
 * `default_agent_id`, or switching the model all change what the agent would
 * write while leaving the object graph untouched — and on a facts-only
 * fingerprint the day's cache would replay the old prose under the new agent's
 * name, crediting it with something it didn't write.
 */
export function briefInputHash(
	facts: BriefingFacts,
	author: BriefAuthorFingerprint = { agentId: null, systemPrompt: null, model: null },
): string {
	return createHash('sha256').update(JSON.stringify({ facts, author })).digest('hex').slice(0, 16)
}

/**
 * Resolve the agent that speaks for the workspace, mirroring the frontend's
 * `useDefaultChatAgent` (apps/web/src/hooks/use-actors.ts): the pinned
 * `default_agent_id`, then the Chief of Staff by name, then the Workspace
 * Coach. Its system prompt is the brief's voice, and its `llm_provider` /
 * `llm_config` decide which provider writes it.
 */
export async function resolveBriefingAgent(
	db: Database,
	workspaceId: string,
	settings: WorkspaceSettings,
): Promise<typeof actors.$inferSelect | null> {
	// Actors carry no workspace column — membership is the join. Every lookup
	// here goes through `workspace_members`, or a workspace would pick up
	// another workspace's Chief of Staff (they all share the name).
	const memberActor = (where: ReturnType<typeof and>) =>
		db
			.select({ actor: actors })
			.from(workspaceMembers)
			.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
			.where(and(eq(workspaceMembers.workspaceId, workspaceId), where))
			.limit(1)

	const pinnedId = (settings as { default_agent_id?: string | null }).default_agent_id
	if (typeof pinnedId === 'string' && pinnedId.length > 0) {
		const [pinned] = await memberActor(eq(actors.id, pinnedId))
		if (pinned) return pinned.actor
	}

	for (const name of [CHIEF_OF_STAFF_DEFAULT.name, LEGACY_DEFAULT_AGENT_NAME]) {
		const [found] = await memberActor(and(eq(actors.type, 'agent'), eq(actors.name, name)))
		if (found) return found.actor
	}
	return null
}

/**
 * The task block appended to the agent's own system prompt. It sets the *form*
 * — spoken register, length, what not to say — and deliberately says nothing
 * about how much judgment to apply. That is the agent's own prompt's job, so
 * editing the Chief of Staff in the UI changes how opinionated the brief is.
 *
 * The "spoken aloud" instruction is load-bearing rather than decorative:
 * SpeechSynthesis derives all of its pausing and intonation from sentence
 * structure and punctuation, so prose written to be read silently comes out
 * flat.
 */
export function buildScriptInstruction(labels: BriefingFacts['labels']): string {
	const bet = labels.bet.toLowerCase()
	return `## Right now: the morning brief

You are writing the workspace's brief for its owner. It will be **spoken aloud** by a text-to-speech voice, so write it the way you would say it out loud, not the way you would type it.

Voice:
- Talk to them directly — "you", contractions, the register of someone who has already read everything and is telling them what matters.
- Full sentences with real punctuation. Commas and full stops are what give the spoken voice its pauses, so vary sentence length and let it breathe.
- Open by naming the single most important thing. No greeting, no "here's your briefing", no throat-clearing about what the brief contains.
- 120 to 200 words. Name at most three things — the rest exists and can wait.
- Close on the one thing that actually needs them today. If nothing does, say so plainly and stop.

Never:
- Headings, bullet points, markdown, asterisks, backticks, links or object ids. It is spoken, so none of it survives.
- Symbols or shorthand a voice would stumble over — write "three of five ${bet}s", not "3/5".
- Status words quoted as jargon. Say a ${bet} "stalled" or "shipped", not "[status: succeeded]".
- Filler about being an assistant, or offers to help further.

Ground every claim in the facts below. You choose what leads, what gets cut, and what is worth connecting — but do not invent progress, status, or anything not present in the data. If the workspace is empty, say that in a sentence and stop.

Reply with the spoken text only.`
}

/** Compact JSON — the facts are the bulk of the prompt, so shape matters. */
export function buildFactsMessage(facts: BriefingFacts): string {
	return JSON.stringify({
		workspace: facts.workspaceName,
		today: utcDateStamp(new Date()),
		labels: facts.labels,
		active: facts.activeBets.map((b) => ({
			title: b.title,
			status: b.status,
			appetite: b.appetite ?? undefined,
			tasks: b.progress ? `${b.progress.done} of ${b.progress.total} done` : undefined,
			about: b.excerpt || undefined,
		})),
		paused: facts.pausedBets.map((b) => b.title),
		closed_last_30_days: facts.closedBets.map((b) => ({
			title: b.title,
			status: b.status,
			verdict: b.verdict ?? undefined,
		})),
		open_insights: facts.openInsights.map((i) => i.title),
		recent_learnings: facts.ledgerLines,
	})
}

/**
 * Object ids the script actually names, so the card's MENTIONED row points at
 * things that were talked about. Title matching finds the ones named outright;
 * active bets are always included because they are what the brief is about
 * even when the script paraphrases their titles.
 */
export function resolveMentionedIds(facts: BriefingFacts, script: string): string[] {
	const haystack = script.toLowerCase()
	const ids = new Set(facts.activeBets.map((b) => b.id))
	const candidates = [...facts.pausedBets, ...facts.closedBets, ...facts.openInsights]
	for (const candidate of candidates) {
		// Short titles ("Q3", "Ops") match half the alphabet by accident.
		const needle = candidate.title.replace(/…$/, '').trim().toLowerCase()
		if (needle.length >= 6 && haystack.includes(needle)) ids.add(candidate.id)
	}
	return [...ids]
}

/**
 * The brief when no model writes it — no credentials, or the call failed. Not
 * the agent markdown: flowing sentences, so the play button still produces
 * something worth listening to rather than a spoken bullet list.
 */
export function formatSpokenFallback(facts: BriefingFacts): string {
	if (!facts.found) return 'That workspace no longer exists, so there is nothing to brief you on.'

	const bet = facts.labels.bet.toLowerCase()
	const task = facts.labels.task.toLowerCase()
	const insight = facts.labels.insight.toLowerCase()
	const sentences: string[] = []

	if (facts.activeBets.length === 0) {
		const waiting =
			facts.openInsights.length === 1
				? `is one open ${insight}`
				: `are ${countPhrase(facts.openInsights.length, insight)}`
		sentences.push(
			facts.openInsights.length > 0
				? `Nothing is running in ${facts.workspaceName} right now, though there ${waiting} waiting to be turned into a ${bet}.`
				: `Nothing is running in ${facts.workspaceName} right now.`,
		)
	} else {
		const [lead] = facts.activeBets
		if (!lead) throw new Error('unreachable: activeBets is non-empty')
		sentences.push(
			`${facts.workspaceName} has ${countPhrase(facts.activeBets.length, bet)} in flight, led by ${lead.title}, which is ${lead.status}${lead.progress ? ` with ${spellOut(lead.progress.done)} of ${spellOut(lead.progress.total)} ${task}s done` : ''}.`,
		)
		const rest = facts.activeBets.slice(1, 3)
		if (rest.length > 0) {
			sentences.push(`Also moving: ${joinWords(rest.map((b) => b.title))}.`)
		}
	}

	const [closed] = facts.closedBets
	if (closed) {
		sentences.push(
			`Recently closed: ${closed.title}${closed.verdict ? `. The verdict was ${closed.verdict}` : ''}.`,
		)
	}

	const lastLearning = facts.ledgerLines[facts.ledgerLines.length - 1]
	if (lastLearning) {
		sentences.push(`Last session left a note: ${lastLearning}`)
	}

	// Says only what the facts contain. `BriefingBetFact.progress` carries a
	// done/total rollup and nothing about blocked children, so the earlier
	// "Nothing is blocked" claim asserted something this function never checked
	// — the same invention the model is instructed not to make.
	sentences.push(
		facts.activeBets.length > 0
			? 'Pick up whichever of those you have the appetite for.'
			: 'Nothing needs you today.',
	)

	return sentences.join(' ')
}

const NUMBER_WORDS = [
	'zero',
	'one',
	'two',
	'three',
	'four',
	'five',
	'six',
	'seven',
	'eight',
	'nine',
	'ten',
]

/** Digits make TTS read "3" as a bare token mid-sentence; words don't. */
function spellOut(n: number): string {
	return NUMBER_WORDS[n] ?? String(n)
}

function countPhrase(n: number, noun: string): string {
	return `${spellOut(n)} ${noun}${n === 1 ? '' : 's'}`
}

function joinWords(items: string[]): string {
	const last = items[items.length - 1]
	if (last === undefined) return ''
	if (items.length === 1) return last
	return `${items.slice(0, -1).join(', ')} and ${last}`
}

/**
 * The card's headline. The script is spoken prose, so its own first sentence
 * is the only honest title for it.
 */
export function deriveHeadline(script: string): string {
	const trimmed = script.trim()
	const firstSentence = trimmed.split(/(?<=[.!?])\s/)[0] ?? trimmed
	return firstSentence.length > 140 ? `${firstSentence.slice(0, 139)}…` : firstSentence
}

async function readCache(
	storage: StorageProvider,
	key: string,
	inputHash: string,
): Promise<CachedBrief | null> {
	try {
		if (!(await storage.exists(key))) return null
		const cached = JSON.parse((await storage.get(key)).toString('utf-8')) as CachedBrief
		return cached.inputHash === inputHash ? cached : null
	} catch (err) {
		// A malformed or unreadable cache entry is not worth failing the brief
		// over — regenerate and overwrite it.
		logger.warn('Failed to read cached brief', { key, error: String(err) })
		return null
	}
}

/**
 * The credentials the brief would be written with, or null when the workspace
 * has no chat-callable route (e.g. an agent whose only route is Claude OAuth,
 * which `resolveChatCredentials` intentionally cannot use out-of-container).
 *
 * Split out because it is now needed twice over: once to fingerprint the day's
 * cache, and once to actually make the call.
 */
function resolveBriefCredentials(
	ws: typeof workspaces.$inferSelect | undefined,
	settings: WorkspaceSettings,
	agent: typeof actors.$inferSelect,
) {
	const llmConfig = (agent.llmConfig as Record<string, unknown> | null) ?? {}
	return resolveChatCredentials({
		wsSettings: settings,
		// Absent row => treat as entitled, i.e. refuse the Maskin key. A brief we
		// can't attribute to a readable workspace degrades to no spoken script,
		// which is the safe direction.
		workspace: {
			enterpriseGranted: ws ? ws.enterpriseGranted : true,
			billingOwnerId: ws?.billingOwnerId ?? null,
		},
		agent: {
			provider: agent.llmProvider,
			apiKey: (llmConfig.api_key as string | undefined)?.trim() || null,
			model: (llmConfig.model as string | undefined)?.trim() || null,
		},
	})
}

/**
 * The human-facing daily brief: the workspace's own default agent, writing
 * from the same facts the agent briefing is built from.
 *
 * Generated on demand — when someone presses play, never on a schedule and
 * never at session start — then cached for the rest of the UTC day under a
 * fingerprint of the facts *and its author*, so pressing play again costs
 * nothing unless the workspace, the agent, or its model actually changed.
 * `BriefCacheCleaner` sweeps yesterday's files.
 *
 * Provider-agnostic by construction: `resolveChatCredentials` falls through
 * the agent's own key, the workspace's custom OpenAI-compatible endpoint (the
 * OpenRouter / vLLM / Ollama path), the workspace Anthropic key, and finally
 * the operator fallback — preferring each tier's small/fast model. When none
 * of those exist, or the call fails, the deterministic fallback prose runs so
 * the play button always produces speech.
 */
export async function generateSpokenBrief(
	db: Database,
	storage: StorageProvider,
	workspaceId: string,
	options: { now?: Date } = {},
): Promise<SpokenBrief> {
	const now = options.now ?? new Date()
	const facts = await collectBriefingFacts(db, storage, workspaceId)

	// Resolved before the cache is read, not after: the agent and the model it
	// would use are part of the fingerprint, so they have to be known to decide
	// whether the cached script is still the one this workspace would produce.
	// Two selects on the hit path, against the model call they exist to avoid.
	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	const settings = (ws?.settings as WorkspaceSettings) ?? ({} as WorkspaceSettings)
	const agent = ws ? await resolveBriefingAgent(db, workspaceId, settings) : null
	const credentials = agent ? resolveBriefCredentials(ws, settings, agent) : null
	// The prompt as it would actually be sent — the agent's own, or the default
	// it falls back to. Hashing `agent.systemPrompt` raw would miss an edit that
	// blanks it, which changes the voice just as much as rewriting it.
	const systemPrompt = agent ? agent.systemPrompt?.trim() || CHIEF_OF_STAFF_SYSTEM_PROMPT : null

	const inputHash = briefInputHash(facts, {
		agentId: agent?.id ?? null,
		systemPrompt,
		model: credentials?.model ?? null,
	})
	const key = briefCacheKey(workspaceId, now)

	const cached = await readCache(storage, key, inputHash)
	if (cached) {
		const { inputHash: _ignored, ...brief } = cached
		return { ...brief, cached: true }
	}

	let script: string | null = null
	let model: string | null = null
	// Whether this result is worth keeping for the rest of the day. A fallback
	// written because the workspace has no callable credentials is stable and
	// cheap to reuse; one written because a call *failed* is not — caching that
	// would pin the workspace to degraded prose until the facts change or UTC
	// midnight, and every retry would silently read the failure back.
	let cacheable = true

	if (agent) {
		if (credentials) {
			try {
				const adapter = createLLMAdapter(credentials.provider, {
					api_key: credentials.apiKey,
					base_url: credentials.baseUrl,
				})
				const response = await adapter.chat({
					model: credentials.model,
					temperature: SCRIPT_TEMPERATURE,
					max_tokens: MAX_SCRIPT_TOKENS,
					messages: [
						{
							role: 'system',
							content: [systemPrompt, buildScriptInstruction(facts.labels)].join('\n\n'),
						},
						{ role: 'user', content: buildFactsMessage(facts) },
					],
				})
				const content = response.content?.trim()
				if (content) {
					script = content
					model = credentials.model
				} else {
					// Reasoning models occasionally spend the whole budget on
					// thinking and return nothing — same failure `callLlm` retries.
					cacheable = false
					logger.warn('Brief script came back empty — using fallback prose', {
						workspaceId,
						model: credentials.model,
					})
				}
			} catch (err) {
				cacheable = false
				logger.warn('Brief script generation failed — using fallback prose', {
					workspaceId,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		} else {
			// Not an error: the agent's only route may be Claude OAuth, which
			// resolveChatCredentials intentionally cannot use out-of-container.
			logger.info('No chat-callable credentials for the brief — using fallback prose', {
				workspaceId,
				agentId: agent.id,
			})
		}
	}

	const source: SpokenBriefSource = script ? 'agent' : 'fallback'
	const finalScript = script ?? formatSpokenFallback(facts)

	const brief: SpokenBrief = {
		workspaceId,
		headline: deriveHeadline(finalScript),
		script: finalScript,
		mentionedIds: resolveMentionedIds(facts, finalScript),
		generatedAt: now.toISOString(),
		source,
		cached: false,
		// Only credit the agent when it actually wrote the script. Resolving an
		// agent is not authorship: the fallback paths resolve one too, and
		// crediting it there tells the reader a named colleague wrote prose that
		// `formatSpokenFallback` concatenated.
		agent: source === 'agent' && agent ? { id: agent.id, name: agent.name } : null,
		model,
	}

	// The no-credentials fallback is worth caching — the prose is deterministic,
	// so every press would otherwise re-run the queries for an identical result.
	// A fallback caused by a failed call is not: see `cacheable` above.
	if (cacheable) {
		try {
			const { cached: _cached, ...persisted } = brief
			await storage.put(key, Buffer.from(JSON.stringify({ ...persisted, inputHash }), 'utf-8'))
		} catch (err) {
			logger.warn('Failed to cache brief', { key, error: String(err) })
		}
	}

	return brief
}
