/**
 * self-start-limits.ts — the gate on work agents start for themselves (bet "Agents take the lead",
 * task "Cap and budget agents' self-started work").
 *
 * One call, made from startSession() before any row is written: admitSessionStart(). It
 *   1. labels the session with WHY it started (`config.start_reason`, one place),
 *   2. caps automatic continuations of one reason on one object at 2 in a row,
 *   3. backs off after 2 self-started runs in a row that changed nothing on the object, and asks a
 *      person after 3,
 *   4. holds a per-agent daily token budget for self-started runs (warns at 80%, stops at 100%).
 * A session a person started is never refused. Every refusal is written as a `session_admission`
 * event (decision `blocked` or `deferred`) and throws SessionNotAdmittedError; callers that start
 * work in the background treat that as "not started", not as a failure.
 *
 * The daily budget per agent is only enforced when a person sets an amount
 * (`settings.agent_daily_budget`); caps and back-off need no setting. FEATURE_SELF_START_LIMITS=0
 * switches every refusal off (the label is still written). A bug in the gate must not stop work,
 * so an unexpected error inside it admits the session and logs.
 *
 * Decisions are pure functions over facts read from the database, so each rule is tested apart.
 */
import type { Database } from '@maskin/db'
import { events, actors, sessions, workspaceMembers, workspaces } from '@maskin/db/schema'
import {
	CONTINUATION_REASONS,
	FOR_YOU_KIND,
	MAX_AUTOMATIC_CONTINUATIONS,
	SELF_STARTED_REASONS,
	type SessionStartReason,
	agentDailyBudgetSchema,
	sessionStartReasonSchema,
} from '@maskin/shared'
import { and, desc, eq, gte, inArray, notInArray, sql } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { postComment } from '../lib/comments'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { insertNotificationsWithEvents } from '../lib/notifications'
import {
	SESSION_ADMISSION_ACTION,
	localDay,
	localDayStart,
	readDailyTarget,
} from './daily-budget-events'
import { resolveSourceActor } from './push-schedule-shared'

export const SELF_START_LIMITS_KILLSWITCH_ENV_VAR = 'FEATURE_SELF_START_LIMITS'
export const SELF_START_CARD_SOURCE = 'self_start_limits'
/** Wait after the 2nd run in a row that changed nothing; doubled for each run after that. */
export const BACKOFF_BASE_MS = 60 * 60_000
export const BACKOFF_CEILING_MS = 24 * 60 * 60_000
export const NO_CHANGE_RUNS_BEFORE_BACKOFF = 2
/** Triggers an agent may leave pending that it made while running a self-started session. */
export const MAX_PENDING_TRIGGERS_FROM_SELF_STARTED_RUNS = 3
export const NO_CHANGE_RUNS_BEFORE_DECISION = 3
/** Written on the object when a person is asked to extend, reassign or close; marks the extend reply. */
export const BACKOFF_ASK_ACTION = 'self_start_backoff_ask'
const GATE_BOOKKEEPING_ACTIONS = ['self_start_cap_note', BACKOFF_ASK_ACTION]
/** Share of the daily budget at which the warning goes out. */
export const BUDGET_WARN_SHARE = 0.8
/** Newer than this many sessions on one object and agent are read when judging a streak. */
const STREAK_LOOKBACK = 8
const CARD_RANK = 20

export type AdmissionRefusal =
	| 'continuation_cap'
	| 'no_change_backoff'
	| 'no_change_decision'
	| 'agent_daily_budget'

export class SessionNotAdmittedError extends HTTPException {
	constructor(
		public readonly refusal: AdmissionRefusal,
		public readonly decision: 'blocked' | 'deferred',
		public readonly reason: SessionStartReason,
		public readonly retryAt: Date | null,
		message: string,
	) {
		super(429, { message })
		this.name = 'SessionNotAdmittedError'
	}
}

// ── Labels ─────────────────────────────────────────────────────────────────

export interface StartReasonInput {
	callerKind: string
	config?: Record<string, unknown>
	triggerType?: string
	retryOf?: string
	hasChat: boolean
	/** Whether the person or agent that asked is a human, an agent, or not known. */
	creatorType: 'human' | 'agent' | 'unknown'
}

/** Why a session started. A caller's own `config.start_reason` wins when it is a known value. */
export function classifyStartReason(input: StartReasonInput): SessionStartReason {
	const own = sessionStartReasonSchema.safeParse(input.config?.start_reason)
	if (own.success) return own.data
	if (input.config?.task_restart) return 'task_restart'
	if (input.retryOf) return 'retry'
	if (input.callerKind === 'chat' || input.hasChat) return 'person'
	if (input.triggerType === 'cron') return 'trigger_cron'
	if (input.triggerType === 'reminder') return 'self_wakeup'
	if (input.triggerType === 'event') return 'trigger_event'
	if (input.callerKind === 'internal') return 'internal'
	if (input.creatorType === 'human') return 'person'
	if (input.creatorType === 'agent') return 'agent_request'
	return 'internal'
}

export function isSelfStarted(reason: SessionStartReason): boolean {
	return SELF_STARTED_REASONS.includes(reason)
}

export function isContinuation(reason: SessionStartReason): boolean {
	return CONTINUATION_REASONS.includes(reason)
}

// ── Pure decisions ─────────────────────────────────────────────────────────

export interface StreakSession {
	id: string
	/** `config.start_reason`; null for a session from before the label existed. */
	reason: SessionStartReason | null
	live: boolean
	createdAt: Date
	startedAt: Date | null
	completedAt: Date | null
	/** The plan asked for this run to check something, so it counts as a change. */
	plannedCheck: boolean
	/**
	 * The person-started run that answered a back-off ask, i.e. an "extend". It is not a run of the
	 * streak and not a change on the object: the quiet count runs on across it.
	 */
	extend?: boolean
}

/** Sessions newest first, from the newest one back to the first that is not `reason`. */
export function continuationStreak(sessions: StreakSession[], reason: SessionStartReason): number {
	let n = 0
	for (const s of sessions) {
		if (s.reason !== reason) break
		n++
	}
	return n
}

export function continuationCapReached(streak: number): boolean {
	return streak >= MAX_AUTOMATIC_CONTINUATIONS
}

/**
 * Marks the extend runs: for each time a person was asked, the first person-started session after
 * it is that person's answer. `sessions` are newest first; the input is not changed.
 */
export function markExtendSessions<T extends StreakSession>(sessions: T[], askTimes: Date[]): T[] {
	const extendIds = new Set<string>()
	for (const ask of [...askTimes].sort((a, b) => a.getTime() - b.getTime())) {
		const answer = [...sessions]
			.reverse()
			.find((s) => s.reason === 'person' && !extendIds.has(s.id) && s.createdAt >= ask)
		if (answer) extendIds.add(answer.id)
	}
	return sessions.map((s) => (extendIds.has(s.id) ? { ...s, extend: true } : s))
}

/**
 * How many of the newest self-started runs in a row changed nothing, and whether a person extended
 * the streak on the way. `changedAt` holds the times of everything that happened on the object. A
 * run that is still live, or a streak whose newest session is not self-started, counts 0: nothing
 * can be judged yet. An extend run (and what happened while it ran) is skipped, so the count is not
 * reset by the person's reply; a real change after it still resets the count.
 */
export function noChangeStreak(
	sessions: StreakSession[],
	changedAt: Date[],
): { runs: number; extended: boolean } {
	const extendWindows = sessions
		.filter((s) => s.extend)
		.map((s) => ({
			from: (s.startedAt ?? s.createdAt).getTime(),
			to: s.completedAt?.getTime() ?? Number.POSITIVE_INFINITY,
		}))
	const changes = changedAt
		.map((t) => t.getTime())
		.filter((t) => !extendWindows.some((w) => t >= w.from && t <= w.to))

	let n = 0
	let extended = false
	let newest = true
	for (const s of sessions) {
		if (s.extend) {
			if (!s.completedAt) return { runs: 0, extended: false }
			// A change after the extend, before the next run, is a real change.
			if (newest && changes.some((t) => t > (s.completedAt as Date).getTime())) {
				return { runs: 0, extended: false }
			}
			extended = true
			continue
		}
		newest = false
		if (!s.reason || !isSelfStarted(s.reason)) break
		if (s.live || !s.completedAt) return { runs: 0, extended: false }
		const from = (s.startedAt ?? s.createdAt).getTime()
		const to = s.completedAt.getTime()
		const changed = s.plannedCheck || changes.some((t) => t >= from && t <= to)
		if (changed) break
		n++
	}
	return { runs: n, extended: n > 0 && extended }
}

export function noChangeRuns(sessions: StreakSession[], changedAt: Date[]): number {
	return noChangeStreak(sessions, changedAt).runs
}

/** 0 before the 2nd run; then 1x, 2x, 4x ... the base wait, up to the ceiling. */
export function backoffWaitMs(runsWithNoChange: number): number {
	if (runsWithNoChange < NO_CHANGE_RUNS_BEFORE_BACKOFF) return 0
	const doublings = runsWithNoChange - NO_CHANGE_RUNS_BEFORE_BACKOFF
	return Math.min(BACKOFF_BASE_MS * 2 ** doublings, BACKOFF_CEILING_MS)
}

/** `atCeiling` is set only when the wait is the longest there is: a person is asked again then. */
export type BackoffDecision =
	| { kind: 'admit'; atCeiling?: true }
	| { kind: 'wait'; retryAt: Date; waitMs: number; atCeiling?: true }
	| { kind: 'ask' }

/**
 * After 3 quiet runs the first time, a person is asked and nothing starts. Once a person has
 * extended, the quiet count runs on: each further quiet run doubles the wait up to the ceiling.
 */
export function backoffDecision(input: {
	runsWithNoChange: number
	lastEndedAt: Date | null
	now: Date
	extended?: boolean
}): BackoffDecision {
	if (input.runsWithNoChange >= NO_CHANGE_RUNS_BEFORE_DECISION && !input.extended) {
		return { kind: 'ask' }
	}
	const waitMs = backoffWaitMs(input.runsWithNoChange)
	if (waitMs === 0) return { kind: 'admit' }
	const ceiling = waitMs >= BACKOFF_CEILING_MS ? ({ atCeiling: true } as const) : {}
	if (!input.lastEndedAt) return { kind: 'admit', ...ceiling }
	const retryAt = new Date(input.lastEndedAt.getTime() + waitMs)
	return retryAt.getTime() > input.now.getTime()
		? { kind: 'wait', retryAt, waitMs, ...ceiling }
		: { kind: 'admit', ...ceiling }
}

export type BudgetState = 'ok' | 'warn' | 'blocked'

export function budgetState(spentTokens: number, limitTokens: number): BudgetState {
	if (spentTokens >= limitTokens) return 'blocked'
	if (spentTokens >= limitTokens * BUDGET_WARN_SHARE) return 'warn'
	return 'ok'
}

/** The agent's daily token limit for self-started runs, or null when a person has set none. */
export function agentBudgetLimit(settings: unknown, actorId: string): number | null {
	const parsed = agentDailyBudgetSchema.safeParse(
		(settings as { agent_daily_budget?: unknown } | null)?.agent_daily_budget,
	)
	if (!parsed.success) return null
	return parsed.data.per_agent?.[actorId] ?? parsed.data.default_tokens ?? null
}

const REASON_WORDS: Record<SessionStartReason, string> = {
	person: 'person-started',
	agent_request: 'agent-requested',
	trigger_event: 'state-change',
	trigger_cron: 'scheduled',
	self_wakeup: 'self-set wake-up',
	task_restart: 'restart',
	retry: 'retry',
	sweep: 'sweep',
	driver_wake: 'wake-on-change',
	sent_back: 'sent-back',
	internal: 'internal',
}

export function capNoteText(reason: SessionStartReason): string {
	return `I stopped starting this agent on its own here. It already ran ${MAX_AUTOMATIC_CONTINUATIONS} ${REASON_WORDS[reason]} runs in a row on this item, which is the limit. Next step for a person: reply to let it continue, hand the item to someone else, or close it.`
}

// ── Facts from the database ────────────────────────────────────────────────

async function readCreatorType(
	db: Database,
	actorId: string,
): Promise<StartReasonInput['creatorType']> {
	const [row] = await db
		.select({ type: actors.type })
		.from(actors)
		.where(eq(actors.id, actorId))
		.limit(1)
	if (!row) return 'unknown'
	return row.type === 'human' ? 'human' : 'agent'
}

function readReason(config: unknown): SessionStartReason | null {
	const parsed = sessionStartReasonSchema.safeParse(
		(config as { start_reason?: unknown } | null)?.start_reason,
	)
	return parsed.success ? parsed.data : null
}

/** The newest sessions of this agent on this object, newest first. */
async function readRecentSessions(
	db: Database,
	params: { workspaceId: string; actorId: string; objectId: string },
): Promise<{ sessions: StreakSession[]; extendCommentIds: Set<number> }> {
	const rows = await db
		.select({
			id: sessions.id,
			status: sessions.status,
			config: sessions.config,
			createdAt: sessions.createdAt,
			startedAt: sessions.startedAt,
			completedAt: sessions.completedAt,
		})
		.from(sessions)
		.where(
			and(
				eq(sessions.workspaceId, params.workspaceId),
				eq(sessions.actorId, params.actorId),
				eq(sessions.initiatedFromObjectId, params.objectId),
			),
		)
		.orderBy(desc(sessions.createdAt))
		.limit(STREAK_LOOKBACK)
	const asks = await db
		.select({ at: events.createdAt })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, params.workspaceId),
				eq(events.entityId, params.objectId),
				eq(events.action, BACKOFF_ASK_ACTION),
				sql`${events.data}->>'actor_id' = ${params.actorId}`,
			),
		)
	const marked = markExtendSessions(
		rows.map((r) => ({
			id: r.id,
			reason: readReason(r.config),
			live: !r.completedAt,
			createdAt: r.createdAt ?? new Date(0),
			startedAt: r.startedAt,
			completedAt: r.completedAt,
			plannedCheck: (r.config as { planned_check?: unknown } | null)?.planned_check === true,
		})),
		asks.flatMap((a) => (a.at ? [a.at] : [])),
	)
	// The person's reply is what started the extend run; it must not count as a change.
	const extendCommentIds = new Set<number>()
	for (const s of marked) {
		if (!s.extend) continue
		const config = rows.find((r) => r.id === s.id)?.config as {
			source_comment_event_id?: unknown
			mention?: { comment_event_id?: unknown }
		} | null
		const id = Number(config?.source_comment_event_id ?? config?.mention?.comment_event_id)
		if (Number.isFinite(id)) extendCommentIds.add(id)
	}
	return { sessions: marked, extendCommentIds }
}

/**
 * When anything happened to the object (a comment, an edit, a status change) since `since`. Events
 * hang on the object under its own type ('task', 'bet', ...) except comments, which use 'object',
 * so the type is not filtered: the id is unique. The gate's own bookkeeping is left out, or its
 * note would count as the change that ends the quiet streak.
 */
async function readObjectChangeTimes(
	db: Database,
	params: { workspaceId: string; objectId: string; since: Date; ignoreEventIds: Set<number> },
): Promise<Date[]> {
	const rows = await db
		.select({ id: events.id, at: events.createdAt })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, params.workspaceId),
				eq(events.entityId, params.objectId),
				notInArray(events.action, GATE_BOOKKEEPING_ACTIONS),
				gte(events.createdAt, params.since),
			),
		)
	return rows.flatMap((r) => (r.at && !params.ignoreEventIds.has(Number(r.id)) ? [r.at] : []))
}

/** Tokens the agent's self-started runs have used since `dayStart`: input, output and cache writes. */
async function readSelfStartedTokens(
	db: Database,
	params: { workspaceId: string; actorId: string; dayStart: Date },
): Promise<number> {
	const [row] = await db
		.select({
			tokens: sql<string>`coalesce(sum(coalesce(${sessions.inputTokens}, 0) + coalesce(${sessions.outputTokens}, 0) + coalesce(${sessions.cacheCreationInputTokens}, 0)), 0)`,
		})
		.from(sessions)
		.where(
			and(
				eq(sessions.workspaceId, params.workspaceId),
				eq(sessions.actorId, params.actorId),
				gte(sessions.createdAt, params.dayStart),
				inArray(sql`${sessions.config}->>'start_reason'`, [...SELF_STARTED_REASONS]),
			),
		)
	return Number(row?.tokens ?? 0)
}

// ── Telling a person ───────────────────────────────────────────────────────

async function firstHumanOwner(db: Database, workspaceId: string): Promise<string | null> {
	const [owner] = await db
		.select({ id: actors.id })
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(workspaceMembers.role, 'owner'),
				eq(actors.type, 'human'),
			),
		)
		.orderBy(actors.id)
		.limit(1)
	return owner?.id ?? null
}

/**
 * One For You card per `dedupeKey` to the workspace's owners. The key is claimed under an advisory
 * lock against the audit events of cards already made, so a repeat refusal does not repeat the ask.
 */
async function sendOwnerCard(
	db: Database,
	params: { workspaceId: string; dedupeKey: string; headline: string; rationale: string },
): Promise<void> {
	const owners = await db
		.select({ id: actors.id })
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(
			and(
				eq(workspaceMembers.workspaceId, params.workspaceId),
				eq(workspaceMembers.role, 'owner'),
				eq(actors.type, 'human'),
			),
		)
		.orderBy(actors.id)
	for (const owner of owners) {
		const sourceActorId = await resolveSourceActor(db, params.workspaceId, owner.id)
		if (!sourceActorId) continue
		await db.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtext(${`${SELF_START_CARD_SOURCE}:${params.dedupeKey}:${owner.id}`}))`,
			)
			const taken = await tx.execute(sql`
				SELECT 1 FROM events
				WHERE workspace_id = ${params.workspaceId}
					AND entity_type = 'notification'
					AND action = 'created'
					AND data->'metadata'->>'source' = ${SELF_START_CARD_SOURCE}
					AND data->'metadata'->>'dedupe_key' = ${params.dedupeKey}
					AND data->>'targetActorId' = ${owner.id}
				LIMIT 1`)
			if (taken.length > 0) return
			await insertNotificationsWithEvents(tx, {
				workspaceId: params.workspaceId,
				actorId: sourceActorId,
				rows: [
					{
						workspaceId: params.workspaceId,
						type: 'needs_input',
						title: params.headline,
						content: params.rationale,
						sourceActorId,
						targetActorId: owner.id,
						status: 'pending',
						metadata: {
							kind: FOR_YOU_KIND,
							rank: CARD_RANK,
							headline: params.headline,
							rationale: params.rationale,
							source: SELF_START_CARD_SOURCE,
							dedupe_key: params.dedupeKey,
						},
					},
				],
			})
		})
	}
}

// ── The gate ───────────────────────────────────────────────────────────────

export interface AdmitInput {
	workspaceId: string
	actorId: string
	callerKind: string
	config?: Record<string, unknown>
	triggerType?: string
	retryOf?: string
	hasChat: boolean
	createdBy: string
	initiatedFromObjectId: string | null
}

export interface Admitted {
	reason: SessionStartReason
	selfStarted: boolean
}

async function refuse(
	db: Database,
	input: AdmitInput,
	params: {
		refusal: AdmissionRefusal
		decision: 'blocked' | 'deferred'
		reason: SessionStartReason
		retryAt?: Date | null
		message: string
		data?: Record<string, unknown>
	},
): Promise<never> {
	// No session row exists for a refused start, so the audit event hangs on the agent.
	await recordEvent(db, {
		workspaceId: input.workspaceId,
		actorId: input.actorId,
		action: SESSION_ADMISSION_ACTION,
		entityType: 'actor',
		entityId: input.actorId,
		data: {
			decision: params.decision,
			refusal: params.refusal,
			start_reason: params.reason,
			caller_kind: input.callerKind,
			object_id: input.initiatedFromObjectId,
			retry_at: params.retryAt?.toISOString() ?? null,
			...params.data,
		},
	}).catch((err) =>
		logger.warn('Failed to write refused session_admission event', { error: String(err) }),
	)
	logger.info('Self-started session not admitted', {
		workspaceId: input.workspaceId,
		actorId: input.actorId,
		refusal: params.refusal,
		reason: params.reason,
		objectId: input.initiatedFromObjectId,
	})
	throw new SessionNotAdmittedError(
		params.refusal,
		params.decision,
		params.reason,
		params.retryAt ?? null,
		params.message,
	)
}

/** Posts the note on the object once per streak, from the agent that was stopped. */
async function leaveCapNote(
	db: Database,
	input: AdmitInput,
	reason: SessionStartReason,
	headSessionId: string | undefined,
): Promise<void> {
	if (!input.initiatedFromObjectId) return
	const objectId = input.initiatedFromObjectId
	const dedupeKey = `cap:${objectId}:${input.actorId}:${reason}:${headSessionId ?? 'none'}`
	const [already] = await db
		.select({ id: events.id })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, input.workspaceId),
				eq(events.entityId, objectId),
				eq(events.action, 'self_start_cap_note'),
				sql`${events.data}->>'dedupe_key' = ${dedupeKey}`,
			),
		)
		.limit(1)
	if (already) return
	const ownerId = await firstHumanOwner(db, input.workspaceId)
	await recordEvent(db, {
		workspaceId: input.workspaceId,
		actorId: input.actorId,
		action: 'self_start_cap_note',
		entityType: 'object',
		entityId: objectId,
		data: { dedupe_key: dedupeKey, start_reason: reason },
	})
	await postComment(db, {
		workspaceId: input.workspaceId,
		actorId: input.actorId,
		entityId: objectId,
		content: capNoteText(reason),
		mentions: ownerId ? [ownerId] : undefined,
		attention: 3,
	})
}

/**
 * Asks the owners once per `dedupeKey`, and marks the object with the time of the ask so that a
 * person's reply afterwards is read as the answer (an extend), not as a change.
 */
async function askOnce(
	db: Database,
	input: AdmitInput,
	params: { dedupeKey: string; headline: string; rationale: string },
): Promise<void> {
	if (!input.initiatedFromObjectId) return
	const objectId = input.initiatedFromObjectId
	try {
		const [already] = await db
			.select({ id: events.id })
			.from(events)
			.where(
				and(
					eq(events.workspaceId, input.workspaceId),
					eq(events.entityId, objectId),
					eq(events.action, BACKOFF_ASK_ACTION),
					sql`${events.data}->>'dedupe_key' = ${params.dedupeKey}`,
				),
			)
			.limit(1)
		if (!already) {
			await recordEvent(db, {
				workspaceId: input.workspaceId,
				actorId: input.actorId,
				action: BACKOFF_ASK_ACTION,
				entityType: 'object',
				entityId: objectId,
				data: { actor_id: input.actorId, dedupe_key: params.dedupeKey },
			})
		}
		await sendOwnerCard(db, { workspaceId: input.workspaceId, ...params })
	} catch (err) {
		logger.warn('Failed to send the back-off card', { error: String(err) })
	}
}

async function checkObjectLimits(
	db: Database,
	input: AdmitInput,
	reason: SessionStartReason,
	now: Date,
): Promise<void> {
	const objectId = input.initiatedFromObjectId
	if (!objectId) return
	const { sessions: recent, extendCommentIds } = await readRecentSessions(db, {
		workspaceId: input.workspaceId,
		actorId: input.actorId,
		objectId,
	})

	if (isContinuation(reason) && continuationCapReached(continuationStreak(recent, reason))) {
		await leaveCapNote(db, input, reason, recent[0]?.id).catch((err) =>
			logger.warn('Failed to leave the continuation cap note', { error: String(err) }),
		)
		await refuse(db, input, {
			refusal: 'continuation_cap',
			decision: 'blocked',
			reason,
			message: `Not started: ${MAX_AUTOMATIC_CONTINUATIONS} automatic ${reason} runs in a row on this object.`,
			data: { streak: continuationStreak(recent, reason) },
		})
	}

	const oldest = recent.reduce<Date | null>((min, s) => {
		const at = s.startedAt ?? s.createdAt
		return !min || at < min ? at : min
	}, null)
	if (!oldest) return
	const changes = await readObjectChangeTimes(db, {
		workspaceId: input.workspaceId,
		objectId,
		since: oldest,
		ignoreEventIds: extendCommentIds,
	})
	const { runs: quiet, extended } = noChangeStreak(recent, changes)
	const decision = backoffDecision({
		runsWithNoChange: quiet,
		// The wait counts from the last self-started run, not from the person's extend reply.
		lastEndedAt: recent.find((s) => !s.extend)?.completedAt ?? null,
		now,
		extended,
	})
	if (decision.kind !== 'ask' && 'atCeiling' in decision) {
		// The wait is the longest there is: ask again, at most once a day for this agent and item.
		await askOnce(db, input, {
			dedupeKey: `backoff_ceiling:${objectId}:${input.actorId}:${now.toISOString().slice(0, 10)}`,
			headline: 'An agent keeps running here and nothing changes. Extend, reassign or close?',
			rationale: `${quiet} runs in a row started on their own and changed nothing on the item, and the wait between runs is now the longest there is (24 hours). Recommended: close it, or reassign it if it still matters. To extend, reply on the item; the wait stays this long until something changes.`,
		})
	}
	if (decision.kind === 'wait') {
		await refuse(db, input, {
			refusal: 'no_change_backoff',
			decision: 'deferred',
			reason,
			retryAt: decision.retryAt,
			message: `Not started yet: ${quiet} runs in a row changed nothing here. Next run is allowed after ${decision.retryAt.toISOString()}.`,
			data: { runs_with_no_change: quiet, wait_ms: decision.waitMs },
		})
	}
	if (decision.kind === 'ask') {
		await askOnce(db, input, {
			dedupeKey: `backoff:${objectId}:${input.actorId}:${recent[0]?.id ?? 'none'}`,
			headline: 'An agent keeps running here and nothing changes. Extend, reassign or close?',
			rationale: `${quiet} runs in a row started on their own and changed nothing on the item, so I stopped starting more. Recommended: close it, or reassign it if it still matters. To extend, reply on the item and the agent will run again, more slowly each time while nothing changes. Nothing else happens until you decide.`,
		})
		await refuse(db, input, {
			refusal: 'no_change_decision',
			decision: 'blocked',
			reason,
			message: `Not started: ${quiet} runs in a row changed nothing here. A person has been asked to extend, reassign or close it.`,
			data: { runs_with_no_change: quiet },
		})
	}
}

async function checkAgentBudget(
	db: Database,
	input: AdmitInput,
	reason: SessionStartReason,
	now: Date,
): Promise<void> {
	const [ws] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, input.workspaceId))
		.limit(1)
	const limit = agentBudgetLimit(ws?.settings, input.actorId)
	if (limit === null) return
	const timezone = readDailyTarget(ws?.settings)?.timezone ?? 'UTC'
	const day = localDay(now, timezone)
	const spent = await readSelfStartedTokens(db, {
		workspaceId: input.workspaceId,
		actorId: input.actorId,
		dayStart: localDayStart(day, timezone),
	})
	const state = budgetState(spent, limit)
	if (state === 'ok') return

	const [agent] = await db
		.select({ name: actors.name })
		.from(actors)
		.where(eq(actors.id, input.actorId))
		.limit(1)
	const name = agent?.name ?? 'An agent'
	if (state === 'warn') {
		await sendOwnerCard(db, {
			workspaceId: input.workspaceId,
			dedupeKey: `budget_warn:${input.actorId}:${day}`,
			headline: `${name} is near its daily limit for self-started runs`,
			rationale: `${spent.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} tokens used today by runs it started on its own. At the limit those runs stop and I will ask you. Runs you start still go through.`,
		}).catch((err) => logger.warn('Failed to send the budget warning', { error: String(err) }))
		return
	}
	await sendOwnerCard(db, {
		workspaceId: input.workspaceId,
		dedupeKey: `budget_stop:${input.actorId}:${day}`,
		headline: `${name} hit its daily limit. Raise it or leave it stopped?`,
		rationale: `${spent.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} tokens used today by runs it started on its own, so those runs are stopped until tomorrow. Recommended: leave it stopped unless this work cannot wait. To raise the limit, change the agent daily budget in the workspace settings. Runs you start still go through.`,
	}).catch((err) => logger.warn('Failed to send the budget stop card', { error: String(err) }))
	await refuse(db, input, {
		refusal: 'agent_daily_budget',
		decision: 'blocked',
		reason,
		message: 'Not started: this agent used its daily token budget for self-started runs.',
		data: { spent_tokens: spent, limit_tokens: limit, day },
	})
}

/**
 * The one admission decision. Returns the label to stamp on the session, or throws
 * SessionNotAdmittedError. Never throws anything else: an unexpected failure admits the session.
 */
export async function admitSessionStart(
	db: Database,
	input: AdmitInput,
	env: NodeJS.ProcessEnv = process.env,
	now: Date = new Date(),
): Promise<Admitted> {
	let reason: SessionStartReason = 'internal'
	try {
		const needsCreator =
			!input.hasChat &&
			input.callerKind !== 'chat' &&
			input.callerKind !== 'internal' &&
			!input.triggerType &&
			!input.retryOf
		const creatorType = needsCreator ? await readCreatorType(db, input.createdBy) : 'unknown'
		reason = classifyStartReason({
			callerKind: input.callerKind,
			config: input.config,
			triggerType: input.triggerType,
			retryOf: input.retryOf,
			hasChat: input.hasChat,
			creatorType,
		})
		const selfStarted = isSelfStarted(reason)
		if (!selfStarted || env[SELF_START_LIMITS_KILLSWITCH_ENV_VAR] === '0') {
			return { reason, selfStarted }
		}
		await checkObjectLimits(db, input, reason, now)
		await checkAgentBudget(db, input, reason, now)
		return { reason, selfStarted }
	} catch (err) {
		if (err instanceof SessionNotAdmittedError) throw err
		logger.error('Self-start gate failed, session admitted', {
			workspaceId: input.workspaceId,
			actorId: input.actorId,
			error: String(err),
		})
		return { reason, selfStarted: isSelfStarted(reason) }
	}
}

// ── Scheduled work made by a scheduled run ─────────────────────────────────

/**
 * The start reason of the session an agent is creating a trigger from, when that session was itself
 * self-started. Null when the call carried no session, the session is not the caller's, or a person
 * started it. A claim in a header is checked against the session row before it counts.
 */
export async function selfStartedRunReason(
	db: Database,
	params: { workspaceId: string; actorId: string; sessionId: string | undefined },
): Promise<SessionStartReason | null> {
	if (!params.sessionId) return null
	const [row] = await db
		.select({ config: sessions.config })
		.from(sessions)
		.where(
			and(
				eq(sessions.id, params.sessionId),
				eq(sessions.workspaceId, params.workspaceId),
				eq(sessions.actorId, params.actorId),
			),
		)
		.limit(1)
	const reason = readReason(row?.config)
	return reason && isSelfStarted(reason) ? reason : null
}

/** How many triggers this agent made from self-started runs that are still enabled. */
export async function countPendingTriggersFromSelfStartedRuns(
	db: Database,
	params: { workspaceId: string; actorId: string },
): Promise<number> {
	const rows = await db.execute(sql`
		SELECT count(*)::int AS n
		FROM events e
		JOIN triggers t ON t.id = e.entity_id
		WHERE e.workspace_id = ${params.workspaceId}
			AND e.entity_type = 'trigger'
			AND e.action = 'created'
			AND e.actor_id = ${params.actorId}
			AND e.data->>'created_from_start_reason' IS NOT NULL
			AND t.enabled = true`)
	return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0)
}

/**
 * A scheduled run may create new scheduled work only within a cap. Throws a 429 when the agent
 * already has MAX_PENDING_TRIGGERS_FROM_SELF_STARTED_RUNS such triggers waiting. A run a person
 * started is not limited here.
 */
export async function assertScheduledWorkWithinCap(
	db: Database,
	params: { workspaceId: string; actorId: string; sessionId: string | undefined },
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ createdFromStartReason: SessionStartReason | null }> {
	const reason = await selfStartedRunReason(db, params)
	if (!reason) return { createdFromStartReason: null }
	if (env[SELF_START_LIMITS_KILLSWITCH_ENV_VAR] !== '0') {
		const pending = await countPendingTriggersFromSelfStartedRuns(db, params)
		if (pending >= MAX_PENDING_TRIGGERS_FROM_SELF_STARTED_RUNS) {
			throw new HTTPException(429, {
				message: `This run started on its own and already left ${pending} scheduled triggers waiting. The limit is ${MAX_PENDING_TRIGGERS_FROM_SELF_STARTED_RUNS}. Ask a person to create more, or let one fire first.`,
			})
		}
	}
	return { createdFromStartReason: reason }
}
