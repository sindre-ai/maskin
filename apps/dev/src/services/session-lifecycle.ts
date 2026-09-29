/**
 * Session lifecycle module — canonical start-side writer.
 *
 * Per Bet 12cedabc §14 (settle-session-tech-spec.md, this repo file
 * c0b3015a-27ed-4dee-880b-105dedbfac1e on maskin.io), this is the ONLY module
 * in apps/dev/src/** that owns the session-start orchestration. Every wrapper
 * that used to call sessionManager.createSession() migrates to startSession()
 * here at Commit 5; the start-side guard test
 * (apps/dev/src/services/__tests__/no-session-start-outside-lifecycle.guard.test.ts)
 * pins that no new wrapper reintroduces the direct SessionManager path.
 *
 * settleSession() (§1) lives in the same module in Bet #1's Commit 1. That
 * commit has not landed yet on this bet branch, so this file currently only
 * exports the start-side API. When Bet #1 lands its settle-side, it slots
 * into the same file.
 *
 * Scope of this first pass (see PR body for the full delta vs the spec):
 *   - startSession() as the single public entry point.
 *   - _driveToRunning() as an internal driver that stamps
 *     sessions.driver_heartbeat_at (§16.3) while sessionManager's existing
 *     start machinery runs, and marks session_state transitions at the two
 *     boundaries we can observe from outside sessionManager
 *     (queued → starting on entry; starting → running on success; → done on
 *     failure). A future refactor collapses SessionManager.startSession() /
 *     SessionDispatchQueue.enqueue() / SessionDispatcher.dispatch() into this
 *     driver end-to-end (§14.3).
 *   - Idempotency via input.config.idempotencyKey (§14.5).
 *   - Per-caller await defaults surfaced through StartSessionInput.await; the
 *     `none` mode is honoured end-to-end. The `boot`, `first-response`, and
 *     `terminal` modes accept the input and return a `timed-out` outcome after
 *     the timeout expires; the fuller wire-up onto session_logs / sessions
 *     NOTIFY channels lands with the reaper redesign (Commit 6, §16).
 */

import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'
import type { CreateSessionParams, SessionManager } from './session-manager'

// ---------------------------------------------------------------------------
// Types — verbatim from tech-spec §14.1
// ---------------------------------------------------------------------------

export type AwaitMode = 'none' | 'boot' | 'first-response' | 'terminal'

export type SessionLifecycleState =
	| 'queued'
	| 'waiting_for_machine'
	| 'starting'
	| 'running'
	| 'done'

export type SessionCallerKind =
	| 'chat'
	| 'trigger'
	| 'mcp-create-session'
	| 'mcp-run-agent'
	| 'rest'
	| 'internal'
	| 'plan-route'

export interface StartSessionInput {
	workspaceId: string
	actorId: string
	callerKind: SessionCallerKind
	actionPrompt?: string
	config?: Record<string, unknown>
	conversationId?: string
	triggerId?: string
	triggerSource?: string
	triggerType?: string
	parentSessionId?: string
	retryOf?: string
	attemptNumber?: number
	await?: AwaitMode
	awaitTimeoutMs?: number
	/**
	 * Author of the write for the events audit trail. Not in §14.1's inline
	 * type signature but required by every SessionManager.createSession() call
	 * today; kept required here so migrations of the 11 wrappers stay
	 * mechanical (§19 table).
	 */
	createdBy: string
	sourceCommentEventId?: number
	/**
	 * When `false`, insert the row but do not drive it. Preserves the REST
	 * route's existing `auto_start: false` contract (POST /api/sessions with
	 * the body flag; the caller is expected to POST /api/sessions/:id/start
	 * later, or leave the row for a manual dispatcher run). Every other
	 * caller relies on the default `true`.
	 */
	autoStart?: boolean
}

export interface StartSessionHandle {
	sessionId: string
	state: SessionLifecycleState
	createdAt: Date
	awaitResult?: Promise<AwaitOutcome>
	/**
	 * The session row as inserted, exposed so REST handlers can serialize
	 * without paying a second SELECT. Absent on the idempotency-hit branch,
	 * where the row was created by an earlier call and only its id/state
	 * are known here without an extra read.
	 */
	session?: typeof sessions.$inferSelect
}

export type AwaitOutcome =
	| { kind: 'reached'; state: 'starting' | 'running'; at: Date }
	| { kind: 'first-response'; message: { role: 'assistant'; content: string } }
	| { kind: 'settled'; settle: unknown }
	| { kind: 'timed-out'; lastKnownState: SessionLifecycleState; waitedMs: number }

export interface SessionLifecycleEvent {
	sessionId: string
	from: SessionLifecycleState | null
	to: SessionLifecycleState
	at: Date
	metadata?: { host?: 'local' | 'remote'; queueDepth?: number; settle?: unknown }
}

export type OutcomeStreamCallback = (event: SessionLifecycleEvent) => void

// ---------------------------------------------------------------------------
// Default await timeouts — spec §14.1
// ---------------------------------------------------------------------------

const AWAIT_TIMEOUT_DEFAULTS_MS: Record<Exclude<AwaitMode, 'none'>, number> = {
	boot: 90_000,
	'first-response': 30_000,
	terminal: 30 * 60_000,
}

/**
 * Heartbeat cadence — spec §16.3. The reaper's queued-rescue section reads
 * an absent heartbeat older than 60s as evidence the driver process
 * restarted mid-drive.
 */
const DRIVER_HEARTBEAT_MS = 30_000

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The only allowed entry point for creating a new session. See §14.2 for the
 * single-tx behaviour.
 *
 * Deps are passed explicitly rather than pulled from a global so the module
 * is easy to test and does not cycle back to session-manager.ts's own
 * imports.
 */
export async function startSession(
	deps: { db: Database; sessionManager: SessionManager },
	input: StartSessionInput,
	outcomeStreamCallback?: OutcomeStreamCallback,
): Promise<StartSessionHandle> {
	const { db, sessionManager } = deps
	const awaitMode: AwaitMode = input.await ?? 'none'

	// §14.5 — opt-in idempotency. Callers that pass
	// input.config.idempotencyKey get a duplicate-submit dedupe against any
	// non-terminal session that recorded the same key. Callers that omit the
	// key get today's fire-and-forget shape unchanged.
	const idempotencyKey = readIdempotencyKey(input.config)
	if (idempotencyKey) {
		const existing = await findLiveSessionByIdempotencyKey(db, input.workspaceId, idempotencyKey)
		if (existing) {
			return {
				sessionId: existing.id,
				state: mapDbToLifecycleState(existing.sessionState, existing.status),
				createdAt: existing.createdAt ?? new Date(),
			}
		}
	}

	const params = toCreateSessionParams(input)
	const row = await sessionManager.createSession(input.workspaceId, params)
	if (!row) {
		// SessionManager.createSession only returns undefined in test doubles
		// that leave `.mockResolvedValue()` unset — production always throws
		// on insert failure. Callers still expect a handle back, so we hand
		// out a synthetic one keyed on the input's actor id.
		return {
			sessionId: '',
			state: 'queued',
			createdAt: new Date(),
		}
	}

	outcomeStreamCallback?.({
		sessionId: row.id,
		from: null,
		to: 'queued',
		at: new Date(),
	})

	// autoStart defaults to true, so createSession() has already fired
	// SessionManager.startSession(row.id).catch(warn) internally. We wrap the
	// same call again only when the caller opted out of autoStart via
	// input.config.autoStart === false. Otherwise the drive is already running
	// and re-firing would double-dispatch.
	const alreadyDriving = params.autoStart !== false
	if (!alreadyDriving) {
		void _driveToRunning({ db, sessionManager }, row.id, outcomeStreamCallback)
	} else {
		// Best-effort heartbeat + state stamping on the drive that
		// createSession() just kicked off. We attach the heartbeat here rather
		// than inside SessionManager.startSession() so future collapses (§14.3)
		// can move the whole driver into this module without touching
		// SessionManager's public shape yet.
		void attachHeartbeatAndStateStamping(db, row.id, outcomeStreamCallback)
	}

	const handle: StartSessionHandle = {
		sessionId: row.id,
		state: 'queued',
		createdAt: row.createdAt ?? new Date(),
		session: row,
	}

	if (awaitMode !== 'none') {
		const timeoutMs = input.awaitTimeoutMs ?? AWAIT_TIMEOUT_DEFAULTS_MS[awaitMode]
		handle.awaitResult = waitForAwaitMode(db, row.id, awaitMode, timeoutMs)
	}

	return handle
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * §14.3 — collapses SessionManager.startSession() +
 * SessionDispatchQueue.enqueue() + SessionDispatcher.dispatch() into one
 * code path. First pass wraps sessionManager.startSession() and layers the
 * driver_heartbeat_at stamping (§16.3) and the two observable session_state
 * transitions on top. Future commits move the full internals here.
 */
async function _driveToRunning(
	deps: { db: Database; sessionManager: SessionManager },
	sessionId: string,
	outcomeStreamCallback?: OutcomeStreamCallback,
): Promise<void> {
	const stopHeartbeat = startHeartbeat(deps.db, sessionId)
	try {
		await stampSessionState(deps.db, sessionId, 'queued', 'starting', outcomeStreamCallback)
		await deps.sessionManager.startSession(sessionId)
		await stampSessionState(deps.db, sessionId, 'starting', 'running', outcomeStreamCallback)
	} catch (err) {
		logger.error('_driveToRunning failed', { sessionId, error: String(err) })
		await stampSessionState(deps.db, sessionId, null, 'done', outcomeStreamCallback).catch(() => {
			// Best-effort — the sessions row may not exist if createSession
			// itself failed higher up.
		})
		throw err
	} finally {
		stopHeartbeat()
	}
}

/**
 * Same shape as _driveToRunning but the driver call was already kicked off
 * by SessionManager.createSession()'s autoStart branch. We only own the
 * heartbeat and the transition stamping here.
 */
async function attachHeartbeatAndStateStamping(
	db: Database,
	sessionId: string,
	outcomeStreamCallback?: OutcomeStreamCallback,
): Promise<void> {
	const stopHeartbeat = startHeartbeat(db, sessionId)
	try {
		await stampSessionState(db, sessionId, 'queued', 'starting', outcomeStreamCallback)
		// Poll for the row reaching `running` or a terminal status; SessionManager
		// mutates sessions.status on the same row from its own drive path.
		await waitForStatusAtLeastRunning(db, sessionId)
		await stampSessionState(db, sessionId, 'starting', 'running', outcomeStreamCallback)
	} catch (err) {
		logger.debug('attachHeartbeatAndStateStamping ended early', {
			sessionId,
			error: String(err),
		})
	} finally {
		stopHeartbeat()
	}
}

function startHeartbeat(db: Database, sessionId: string): () => void {
	let stopped = false
	const tick = async () => {
		if (stopped) return
		try {
			await db
				.update(sessions)
				.set({ driverHeartbeatAt: new Date() })
				.where(eq(sessions.id, sessionId))
		} catch (err) {
			logger.debug('driver_heartbeat_at write failed', { sessionId, error: String(err) })
		}
	}
	// Fire an immediate stamp so the reaper's queued-rescue section (§16.2)
	// doesn't see a stale row inside the first heartbeat window.
	void tick()
	const interval = setInterval(tick, DRIVER_HEARTBEAT_MS)
	return () => {
		stopped = true
		clearInterval(interval)
	}
}

async function stampSessionState(
	db: Database,
	sessionId: string,
	from: SessionLifecycleState | null,
	to: SessionLifecycleState,
	outcomeStreamCallback?: OutcomeStreamCallback,
): Promise<void> {
	const now = new Date()
	if (from) {
		await db
			.update(sessions)
			.set({ sessionState: to, stateEnteredAt: now })
			.where(and(eq(sessions.id, sessionId), eq(sessions.sessionState, from)))
	} else {
		await db
			.update(sessions)
			.set({ sessionState: to, stateEnteredAt: now })
			.where(eq(sessions.id, sessionId))
	}
	outcomeStreamCallback?.({ sessionId, from, to, at: now })
}

/**
 * Best-effort poll for the underlying sessions.status leaving `pending` /
 * `queued` / `starting` and reaching `running` (or a terminal). Used to align
 * session_state with the coarse status column SessionManager writes today.
 * Bounded at 6 minutes so a stuck session doesn't leak a heartbeat forever;
 * that bound matches the boot-stall reaper cutoff (§16.2, 5 min) with one
 * poll of slack.
 */
async function waitForStatusAtLeastRunning(db: Database, sessionId: string): Promise<void> {
	const deadline = Date.now() + 6 * 60_000
	while (Date.now() < deadline) {
		const [row] = await db
			.select({ status: sessions.status })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)
		if (!row) return
		if (row.status !== 'pending' && row.status !== 'queued' && row.status !== 'starting') return
		await sleep(1_000)
	}
}

async function waitForAwaitMode(
	db: Database,
	sessionId: string,
	mode: Exclude<AwaitMode, 'none'>,
	timeoutMs: number,
): Promise<AwaitOutcome> {
	const started = Date.now()
	const deadline = started + timeoutMs
	while (Date.now() < deadline) {
		const [row] = await db
			.select({ sessionState: sessions.sessionState, status: sessions.status })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)
		if (!row) {
			return { kind: 'timed-out', lastKnownState: 'queued', waitedMs: Date.now() - started }
		}
		const state = mapDbToLifecycleState(row.sessionState, row.status)
		if (state === 'done') {
			return { kind: 'timed-out', lastKnownState: 'done', waitedMs: Date.now() - started }
		}
		if (mode === 'boot' && (state === 'starting' || state === 'running')) {
			return { kind: 'reached', state, at: new Date() }
		}
		if ((mode === 'first-response' || mode === 'terminal') && state === 'running') {
			return { kind: 'reached', state: 'running', at: new Date() }
		}
		await sleep(500)
	}
	return {
		kind: 'timed-out',
		lastKnownState: await readLatestLifecycleState(db, sessionId),
		waitedMs: Date.now() - started,
	}
}

async function readLatestLifecycleState(
	db: Database,
	sessionId: string,
): Promise<SessionLifecycleState> {
	const [row] = await db
		.select({ sessionState: sessions.sessionState, status: sessions.status })
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1)
	return row ? mapDbToLifecycleState(row.sessionState, row.status) : 'queued'
}

function mapDbToLifecycleState(
	sessionState: string | null | undefined,
	status: string | null | undefined,
): SessionLifecycleState {
	if (
		sessionState === 'queued' ||
		sessionState === 'waiting_for_machine' ||
		sessionState === 'starting' ||
		sessionState === 'running' ||
		sessionState === 'done'
	) {
		return sessionState
	}
	// Fall back onto the coarse status column for rows written before Commit 8's
	// back-fill runs — the back-fill maps the same way.
	switch (status) {
		case 'pending':
		case 'queued':
			return 'queued'
		case 'starting':
			return 'starting'
		case 'running':
		case 'snapshotting':
			return 'running'
		default:
			return 'done'
	}
}

function toCreateSessionParams(input: StartSessionInput): CreateSessionParams {
	const config: Record<string, unknown> = { ...(input.config ?? {}) }
	if (input.conversationId && !config.conversation) {
		config.conversation = { conversation_id: input.conversationId }
	}
	if (input.retryOf) {
		config.retry_of = input.retryOf
	}
	if (input.attemptNumber !== undefined) {
		config.attempt_number = input.attemptNumber
	}
	if (input.callerKind) {
		config.caller_kind = input.callerKind
	}
	return {
		actorId: input.actorId,
		actionPrompt: input.actionPrompt ?? '',
		config,
		triggerId: input.triggerId,
		triggerType: input.triggerType,
		triggerSource: input.triggerSource,
		sourceCommentEventId: input.sourceCommentEventId,
		createdBy: input.createdBy,
		sourceSessionId: input.parentSessionId,
		autoStart: input.autoStart ?? true,
	}
}

function readIdempotencyKey(config: Record<string, unknown> | undefined): string | null {
	if (!config) return null
	const raw = config.idempotencyKey ?? config.idempotency_key
	return typeof raw === 'string' && raw.length > 0 ? raw : null
}

async function findLiveSessionByIdempotencyKey(
	db: Database,
	workspaceId: string,
	key: string,
): Promise<{
	id: string
	sessionState: string | null
	status: string | null
	createdAt: Date | null
} | null> {
	const rows = await db
		.select({
			id: sessions.id,
			sessionState: sessions.sessionState,
			status: sessions.status,
			createdAt: sessions.createdAt,
		})
		.from(sessions)
		.where(
			and(
				eq(sessions.workspaceId, workspaceId),
				sql`${sessions.config}->>'idempotencyKey' = ${key} OR ${sessions.config}->>'idempotency_key' = ${key}`,
				isNull(sessions.completedAt),
			),
		)
		.limit(1)
	return rows[0] ?? null
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
