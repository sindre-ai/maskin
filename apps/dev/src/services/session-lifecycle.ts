/**
 * session-lifecycle.ts — the one entry point for starting AND ending a session.
 *
 * Every start-side wrapper (chat, triggers, REST, MCP, onboarding, self-spawn)
 * routes through startSession(). Every terminal `sessions.status` write in
 * apps/dev/src/** funnels through settleSession(). Per the tech spec §14 + §20,
 * this file is the ONLY module in apps/dev/src/** allowed to call the
 * underlying dispatch primitives — SessionDispatchQueue.enqueue(),
 * SessionDispatcher.dispatch/markDispatched, AgentServerClient.startSession(),
 * ContainerManager.create/start, and the legacy SessionManager.createSession()
 * / SessionManager.startSession(sessionId) — and the ONLY module allowed to
 * write a terminal `sessions.status`.
 *
 * A ts-morph guard test pins the start-side invariant; see
 * no-session-start-outside-lifecycle.guard.test.ts. A second guard test
 * (session-lifecycle.guard.test.ts) pins the terminal-status invariant.
 */
import { and, eq, notInArray, sql } from 'drizzle-orm'

import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db'
import type { SessionResult, SettleSource, TerminalOutcomeKind } from '@maskin/shared'

import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import type { CreateSessionParams, SessionManager } from './session-manager'

// ── Types (spec §14.1) ────────────────────────────────────────────────────

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

export type SessionConfig = Record<string, unknown>

export interface StartSessionInput {
	workspaceId: string
	actorId: string
	callerKind: SessionCallerKind
	actionPrompt?: string
	config?: SessionConfig
	conversationId?: string
	triggerId?: string
	triggerSource?: string
	triggerType?: string
	sourceCommentEventId?: number
	parentSessionId?: string
	retryOf?: string
	attemptNumber?: number
	await?: AwaitMode
	awaitTimeoutMs?: number
	createdBy?: string
	autoStart?: boolean
}

export interface StartSessionHandle {
	sessionId: string
	state: SessionLifecycleState
	createdAt: Date
	awaitResult?: Promise<AwaitOutcome>
	/**
	 * The freshly-inserted sessions row. Present when startSession() actually
	 * inserted (the common case). Absent on an idempotency hit — the caller
	 * only receives sessionId/state/createdAt looked up off the existing row.
	 * Callers needing the full row (e.g. REST /api/sessions to serialize a 201
	 * body) should fetch by sessionId when this is undefined.
	 */
	session?: typeof sessions.$inferSelect
}

export type AwaitOutcome =
	| { kind: 'reached'; state: 'starting' | 'running'; at: Date }
	| { kind: 'first-response'; message: { role: 'assistant'; content: string } }
	| { kind: 'settled'; settle: { status: string } }
	| { kind: 'timed-out'; lastKnownState: SessionLifecycleState; waitedMs: number }

export interface SessionLifecycleEvent {
	sessionId: string
	from: SessionLifecycleState | null
	to: SessionLifecycleState
	at: Date
	metadata?: { host?: 'local' | 'remote'; queueDepth?: number; settle?: { status: string } }
}

export type OutcomeStreamCallback = (event: SessionLifecycleEvent) => void

// ── Configuration (module-scoped singleton, wired once from index.ts) ─────

interface LifecycleDeps {
	db: Database
	sessionManager: SessionManager
}

let _deps: LifecycleDeps | null = null

export function configureSessionLifecycle(deps: LifecycleDeps): void {
	_deps = deps
}

function getDeps(): LifecycleDeps {
	if (!_deps) {
		throw new Error('session-lifecycle not configured; call configureSessionLifecycle() at startup')
	}
	return _deps
}

// ── startSession() (spec §14.2, §14.4, §14.5) ─────────────────────────────

const AWAIT_DEFAULT_TIMEOUT_MS: Record<Exclude<AwaitMode, 'none'>, number> = {
	boot: 90_000,
	'first-response': 30_000,
	terminal: 30 * 60 * 1000,
}

/**
 * The one entry point for creating and starting a session.
 *
 * Single-tx behaviour (delegated to SessionManager.createSession, then the
 * commit-8 lifecycle fields are stamped after):
 *   1. Pre-flight billing-cap + conversation-anchor.
 *   2. Insert row with schema-default session_state='queued', state_entered_at=NOW().
 *   3. Insert session_created event.
 *   4. Insert conversation->session spawned edge if conversationId set.
 *   5. Fire outcomeStreamCallback with {to:'queued'}.
 *
 * Then branches on input.await (defaults to 'none'). For every non-'none'
 * mode, an awaitResult promise is attached to the handle that resolves per
 * spec §14.4. The session itself keeps running past the timeout — timing out
 * only affects the caller's wait.
 */
export async function startSession(
	input: StartSessionInput,
	outcomeStreamCallback?: OutcomeStreamCallback,
): Promise<StartSessionHandle> {
	const { db, sessionManager } = getDeps()

	// §14.5 — opt-in idempotency via input.config.idempotencyKey. Duplicate
	// submits from a jittery MCP client hit the same live row instead of
	// spawning a second session.
	const idempotencyKey = readIdempotencyKey(input.config)
	if (idempotencyKey) {
		const [existing] = await db
			.select({
				id: sessions.id,
				sessionState: sessions.sessionState,
				createdAt: sessions.createdAt,
			})
			.from(sessions)
			.where(
				and(
					eq(sessions.workspaceId, input.workspaceId),
					sql`${sessions.config}->>'idempotencyKey' = ${idempotencyKey}`,
				),
			)
			.limit(1)
		if (existing) {
			return {
				sessionId: existing.id,
				state: (existing.sessionState as SessionLifecycleState) ?? 'queued',
				createdAt: existing.createdAt ?? new Date(),
			}
		}
	}

	const createdBy = input.createdBy ?? input.actorId

	const params: CreateSessionParams = {
		actorId: input.actorId,
		actionPrompt: input.actionPrompt ?? '',
		config: input.config,
		triggerId: input.triggerId,
		triggerType: input.triggerType,
		triggerSource: input.triggerSource,
		sourceCommentEventId: input.sourceCommentEventId,
		createdBy,
		autoStart: input.autoStart,
		sourceSessionId: input.parentSessionId,
	}

	const session = await sessionManager.createSession(input.workspaceId, params)

	// Commit-8 lifecycle fields set on the fresh row. session_state='queued'
	// and state_entered_at=NOW() are schema defaults; attempt_number defaults
	// to 1. Only patch when a non-default is supplied.
	if (input.attemptNumber !== undefined || input.retryOf) {
		const patch: Record<string, unknown> = {}
		if (input.attemptNumber !== undefined) patch.attemptNumber = input.attemptNumber
		if (input.retryOf) patch.retryOf = input.retryOf
		if (Object.keys(patch).length > 0) {
			await db.update(sessions).set(patch).where(eq(sessions.id, session.id))
		}
	}

	if (outcomeStreamCallback) {
		try {
			outcomeStreamCallback({
				sessionId: session.id,
				from: null,
				to: 'queued',
				at: new Date(),
			})
		} catch (err) {
			logger.warn('outcomeStreamCallback threw on queued transition', {
				sessionId: session.id,
				error: String(err),
			})
		}
	}

	const initialState =
		((session as { sessionState?: SessionLifecycleState }).sessionState as
			| SessionLifecycleState
			| undefined) ?? 'queued'

	const handle: StartSessionHandle = {
		sessionId: session.id,
		state: initialState,
		createdAt: session.createdAt ?? new Date(),
		session,
	}

	const awaitMode = input.await ?? 'none'
	if (awaitMode !== 'none') {
		handle.awaitResult = pollForAwait(session.id, awaitMode, input.awaitTimeoutMs)
	}

	return handle
}

function readIdempotencyKey(config: SessionConfig | undefined): string | undefined {
	if (!config) return undefined
	const key = (config as { idempotencyKey?: unknown }).idempotencyKey
	return typeof key === 'string' && key.length > 0 ? key : undefined
}

/**
 * Poll the session row for state transitions matching the caller's awaitMode.
 * Terminal (session_state='done') always resolves. Never kills the session on
 * timeout — the promise just resolves 'timed-out' and the session keeps running.
 */
async function pollForAwait(
	sessionId: string,
	mode: AwaitMode,
	timeoutMsOverride?: number,
): Promise<AwaitOutcome> {
	const { db } = getDeps()
	const timeoutMs = timeoutMsOverride ?? (mode === 'none' ? 0 : AWAIT_DEFAULT_TIMEOUT_MS[mode])
	const startedAt = Date.now()
	const pollMs = 500
	let lastState: SessionLifecycleState = 'queued'

	while (Date.now() - startedAt < timeoutMs) {
		const [row] = await db
			.select({ sessionState: sessions.sessionState, status: sessions.status })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)
		if (!row) break
		const state = (row.sessionState as SessionLifecycleState) ?? 'queued'
		lastState = state
		if (state === 'done') {
			return { kind: 'settled', settle: { status: row.status } }
		}
		if (mode === 'boot' && (state === 'starting' || state === 'running')) {
			return { kind: 'reached', state, at: new Date() }
		}
		if (mode === 'first-response' && state === 'running') {
			return { kind: 'reached', state, at: new Date() }
		}
		await new Promise((r) => setTimeout(r, pollMs))
	}
	return {
		kind: 'timed-out',
		lastKnownState: lastState,
		waitedMs: Date.now() - startedAt,
	}
}

/**
 * Boot budget for a session in session_state='starting' — the reaper's
 * boot-stall cutoff (Commit 6, §16.2). Colocated here (not in session-manager)
 * because the driver in _driveToRunning() is the writer whose deadline this
 * represents: dispatcher retries top out around 8 seconds and a healthy
 * container/agent-server handshake finishes in single-digit seconds, so five
 * minutes is a comfortable ceiling that still catches a real stall long before
 * the old 10-minute zombie sweep would have.
 */
export const BOOT_STALL_MS = 5 * 60 * 1000

/**
 * How often _driveToRunning() rewrites driver_heartbeat_at while it is driving
 * a session from queued through starting to running. Read by the reaper's
 * queued-rescue cutoff (Commit 6, §16.3): a driver that crashes stops
 * heartbeating, the row's driver_heartbeat_at goes stale >60s, and the rescue
 * re-fires _driveToRunning() on the queued row.
 */
export const DRIVER_HEARTBEAT_INTERVAL_MS = 30 * 1000

/**
 * Internal: drive a queued session to running. Called from queue-drain paths
 * (e.g. SessionManager.startQueueDrain) and the reaper's queued-rescue cutoff.
 *
 * While driving, stamps driver_heartbeat_at every DRIVER_HEARTBEAT_INTERVAL_MS
 * so a crash of this process becomes observable to the reaper's queued-rescue
 * cutoff (§16.3): a row still in session_state='queued' with a stale
 * driver_heartbeat_at is one where the previous driver died before the state
 * ever transitioned, so re-firing here is safe.
 *
 * State transitions written here (§15.3): 'queued' → 'starting' before we
 * begin the dispatch, 'running' after startSession returns success. A failure
 * leaves the row in 'starting' so the reaper's boot-stall cutoff (§16.2)
 * settles it once past BOOT_STALL_MS — surfacing genuine startup failures
 * instead of masking them as an infinite queued-rescue loop.
 *
 * The dispatch fork (local docker vs remote agent-server) still lives in
 * SessionManager.startSession() per §14.3.
 */
export async function _driveToRunning(sessionId: string): Promise<void> {
	const { db, sessionManager } = getDeps()

	// Enter 'starting' before the dispatch — the reaper's boot-stall cutoff
	// (§16.2) measures state_entered_at from this write. A driver crash after
	// this point leaves state_entered_at pointing at a real starting instant
	// that the reaper can compare against BOOT_STALL_MS.
	await db
		.update(sessions)
		.set({ sessionState: 'starting', stateEnteredAt: new Date(), driverHeartbeatAt: new Date() })
		.where(eq(sessions.id, sessionId))
		.catch((err) => {
			logger.warn('_driveToRunning failed to enter starting state', {
				sessionId,
				error: String(err),
			})
		})

	const interval = setInterval(() => {
		void stampDriverHeartbeat(db, sessionId).catch((err) => {
			logger.warn('driver_heartbeat_at interval stamp failed', {
				sessionId,
				error: String(err),
			})
		})
	}, DRIVER_HEARTBEAT_INTERVAL_MS)
	// Node's setInterval on a background loop must not keep the process alive
	// if this is the only outstanding timer (e.g. tests that never await the
	// dispatch).
	if (typeof interval.unref === 'function') interval.unref()

	try {
		await sessionManager.startSession(sessionId)
		// Reached 'running' successfully — clear heartbeat so the reaper's
		// stale-heartbeat check no longer applies to this row, and stamp the
		// transition so the wall-timeout cutoff measures 2h from here.
		await db
			.update(sessions)
			.set({ sessionState: 'running', stateEnteredAt: new Date(), driverHeartbeatAt: null })
			.where(eq(sessions.id, sessionId))
			.catch((err) => {
				logger.warn('_driveToRunning failed to enter running state', {
					sessionId,
					error: String(err),
				})
			})
	} catch (err) {
		logger.error('_driveToRunning failed', {
			sessionId,
			error: String(err),
		})
		throw err
	} finally {
		clearInterval(interval)
	}
}

async function stampDriverHeartbeat(db: Database, sessionId: string): Promise<void> {
	await db
		.update(sessions)
		.set({ driverHeartbeatAt: new Date() })
		.where(eq(sessions.id, sessionId))
}


// ═══════════════════════════════════════════════════════════════════════════
// ─── SETTLE SIDE (Bet #1 Commit 2 — merged in from bet/add4d986 branch) ────
// ═══════════════════════════════════════════════════════════════════════════

export type { SettleSource, TerminalOutcomeKind }

/**
 * Why the session ended. Distinct from `TerminalOutcomeKind` (which decides the
 * row's `status`) — classification survives on the row and rides on the
 * `agent_session_completed` PostHog event, so downstream can tell an
 * `agent_completed` apart from a `sandbox_crash` even though both write
 * `status = 'failed'` or `'completed'`.
 */
export type TerminalClassification =
	| 'credit_exhaustion'
	| 'plan_cap'
	| 'failover'
	| 'idle_timeout'
	| 'wall_timeout'
	| 'dispatch_failure'
	| 'startup_stalled'
	| 'sandbox_crash'
	| 'agent_completed'
	| 'agent_blocked'
	| 'human_stop'
	| 'reaper'
	| 'unknown'

export interface SettleUsage {
	inputTokens: number
	outputTokens: number
	cacheReadTokens?: number
	cacheCreationTokens?: number
	costUsd?: number
}

export interface SettleCliReport {
	exitCode?: number
	lastAssistant?: string
	tokensSummary?: unknown
}

export interface SettleOutcome {
	kind: TerminalOutcomeKind
	classification: TerminalClassification
	/** One-line human string, persisted on the row. */
	reason?: string
	/** Sandbox exit code when known. */
	exitCode?: number
	/** Last assistant turn / final summary. */
	resultText?: string
	/**
	 * Overlaid **additively** onto whatever the row already carries — never
	 * overwritten. Two writers arriving with partial usage both contribute,
	 * which is the anti-drop contract for the "usage lost on timeout" failure
	 * mode this bet is closing.
	 */
	usage?: SettleUsage
	/** Verbatim capture of the CLI's own completion report, if any. */
	cliReported?: SettleCliReport
	/** S3 key of the snapshot when `kind === 'pause'`. */
	snapshotKey?: string
	/** Structured provider-side failure reason (feeds `sessions.result`). */
	failureReason?: SessionResult['failure_reason']
	/** Who called settle. */
	source: SettleSource
}

export type FinalStatus = 'completed' | 'failed' | 'timeout' | 'user_stopped' | 'paused'

export type StoppedSandboxOutcome = 'local' | 'remote' | 'skipped-none-live' | 'skipped-error'

export type PushedAgentFilesOutcome = 'ok' | 'skipped-no-workspace' | 'failed'

export interface SettleResult {
	sessionId: string
	finalStatus: FinalStatus
	/** True when the row was already in a terminal state before this call. */
	alreadySettled: boolean
	stoppedSandbox: StoppedSandboxOutcome
	pushedAgentFiles: PushedAgentFilesOutcome
	posthogEmitted: boolean
	events: {
		sessionTimeout?: number
		sessionFailed?: number
		sessionCompleted?: number
		sessionStopped?: number
		sessionPaused?: number
	}
}

/**
 * The subset of a `sessions` row settleSession reads before writing. Kept
 * narrow so tests can pass a bare object without full Drizzle typing.
 */
export interface SessionSettleRow {
	id: string
	workspaceId: string
	actorId: string
	status: string
	containerId: string | null
	agentServerId: string | null
	result: SessionResult | null
}

/**
 * Post-commit side-effect callbacks. settleSession() has no direct import of
 * `ContainerManager`, `AgentServerClient`, or `AgentStorageService` — the
 * SessionManager wires those in at construction time, so this module stays
 * standalone and the guard test's ALLOW path is unambiguous.
 */
export interface SettleDependencies {
	db: Database
	/**
	 * Stop the sandbox this session runs on. Local sessions dispatch to
	 * dockerode; remote sessions dispatch to the agent-server stop RPC. Both
	 * are idempotent — an already-gone sandbox returns `'skipped-none-live'`
	 * (never throws).
	 */
	stopSandbox: (row: SessionSettleRow, outcome: SettleOutcome) => Promise<StoppedSandboxOutcome>
	/**
	 * Push `learnings/` and `memory/` back to S3. For local sessions this
	 * reads the on-disk temp workspace; for remote sessions it dispatches to
	 * the agent-server push-agent-files RPC. settleSession skips this step
	 * for classifications `startup_stalled` and `dispatch_failure` — nothing
	 * was ever written on those paths.
	 */
	pushAgentFiles: (
		row: SessionSettleRow,
		outcome: SettleOutcome,
	) => Promise<PushedAgentFilesOutcome>
}

/**
 * The mapping from a `TerminalOutcomeKind` to the string literal written into
 * `sessions.status`. These five literals are the *only* places in `apps/dev/src`
 * they appear as a write — the guard test in
 * `session-lifecycle.guard.test.ts` enforces that.
 */
const TERMINAL_STATUS_BY_KIND: Record<TerminalOutcomeKind, FinalStatus> = {
	complete: 'completed',
	fail: 'failed',
	timeout: 'timeout',
	stop: 'user_stopped',
	pause: 'paused',
}

/**
 * Statuses whose rows must NOT be flipped by a subsequent settleSession call —
 * the four "truly terminal" states. `paused` is deliberately excluded even
 * though `TERMINAL_STATUS_BY_KIND.pause` maps to it: an expired paused row is
 * still eligible to be archived to `completed` (see session-manager.ts's
 * 7-day archival pass), and the CAS below already lists exactly these four.
 */
const TRULY_TERMINAL_STATUS_SET: ReadonlySet<string> = new Set([
	'completed',
	'failed',
	'timeout',
	'user_stopped',
])

/**
 * Domain-visible `events.action` written by settle for each kind. Matches
 * §8.2 of the tech spec — every terminal write emits exactly one row.
 * `session_timeout` covers the reaper's "no timeoutAt" branch, which today
 * skips the event and silently reads as "session gone" downstream.
 */
const EVENT_ACTION_BY_KIND: Record<TerminalOutcomeKind, string> = {
	complete: 'session_completed',
	fail: 'session_failed',
	timeout: 'session_timeout',
	stop: 'session_stopped',
	pause: 'session_paused',
}

/**
 * Classifications where settleSession skips the post-commit `pushAgentFiles`
 * step. Nothing was ever written to `/agent/learnings` or `/agent/memory`
 * on these paths — a push would upload the empty seed directories and race
 * the reconciler's cleanup for the same session.
 */
const NO_PUSH_CLASSIFICATIONS: ReadonlySet<TerminalClassification> = new Set([
	'startup_stalled',
	'dispatch_failure',
])

/**
 * Public accessor so call-sites and tests never re-encode the mapping.
 */
export function mapKindToFinalStatus(kind: TerminalOutcomeKind): FinalStatus {
	return TERMINAL_STATUS_BY_KIND[kind]
}

/**
 * settleSession — the only writer of a terminal `sessions.status`.
 *
 * Ordered side-effects (per spec §1.5):
 *   1. Conditional UPDATE sessions — reserves the row.
 *      `WHERE status NOT IN ('completed','failed','timeout','user_stopped')`.
 *      A row already in a terminal state returns `alreadySettled: true` and
 *      settle STILL runs the idempotent side-effects (stopSandbox
 *      best-effort, pushAgentFiles best-effort) but does NOT overwrite the
 *      row.
 *   2. (in the same commit) Emit the domain event —
 *      `session_completed` / `session_failed` / `session_timeout` /
 *      `session_stopped` / `session_paused` — so a downstream consumer
 *      subscribed to `events.action` sees exactly one terminal row per
 *      settle.
 *   3. (after commit) `stopSandbox(row, outcome)` — §2.
 *   4. (after commit) `pushAgentFiles(row, outcome)` — §7. Skipped on
 *      `startup_stalled` and `dispatch_failure`.
 *   5. PostHog dual-emit — deferred to commit 4. `posthogEmitted` is always
 *      false in this commit; the existing `maskin_plan_session_completed`
 *      emit stays live at its current site in session-manager.ts.
 *
 * Error semantics (§1.6): throws ONLY when the pre-commit UPDATE errors
 * (DB unreachable). Post-commit failures surface through `SettleResult`
 * fields (`stoppedSandbox: 'skipped-error'`, `pushedAgentFiles: 'failed'`)
 * so callers can log context without retrying the terminal write.
 */
export async function settleSession(
	sessionId: string,
	outcome: SettleOutcome,
	deps: SettleDependencies,
): Promise<SettleResult> {
	const finalStatus = mapKindToFinalStatus(outcome.kind)
	const eventAction = EVENT_ACTION_BY_KIND[outcome.kind]

	// Step 1: SELECT the row (small, non-locking; the conditional UPDATE below
	// is the actual concurrency guard via a CAS on `status NOT IN terminals`).
	const [existing] = await deps.db
		.select({
			id: sessions.id,
			workspaceId: sessions.workspaceId,
			actorId: sessions.actorId,
			status: sessions.status,
			containerId: sessions.containerId,
			agentServerId: sessions.agentServerId,
			result: sessions.result,
		})
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1)

	if (!existing) {
		throw new Error(`settleSession: session ${sessionId} not found`)
	}

	const row: SessionSettleRow = {
		id: existing.id,
		workspaceId: existing.workspaceId,
		actorId: existing.actorId,
		status: existing.status,
		containerId: existing.containerId,
		agentServerId: existing.agentServerId,
		result: (existing.result ?? null) as SessionResult | null,
	}

	const wasAlreadyTerminal = TRULY_TERMINAL_STATUS_SET.has(existing.status)

	// Step 2 + 3: Conditional UPDATE and event insert inside one transaction.
	// A CAS miss (row already terminal, or another writer beat us) leaves
	// `flipped` empty. Best-effort side-effects still run below so an
	// already-terminal row's sandbox does not linger.
	let flipped: { id: string } | undefined
	const events: SettleResult['events'] = {}

	if (!wasAlreadyTerminal) {
		await deps.db.transaction(async (tx) => {
			const now = new Date()
			const merged = mergeResultBlob(row.result, outcome)

			const setPatch: Record<string, unknown> = {
				status: finalStatus,
				completedAt: now,
				updatedAt: now,
				result: merged,
			}
			// Every terminal kind empties the current-activity string so the UI
			// stops showing "typing…" for a session that has actually stopped —
			// including pause, whose UI-side treatment is the same "not running"
			// state a completed row has.
			setPatch.currentActivity = null
			if (outcome.kind === 'pause') {
				// A paused row's container is gone — the caller stops/removes the
				// sandbox as part of the snapshot flow, and any resume path spins
				// up a fresh one. Nulling containerId here means downstream
				// isContainerAlive-style checks correctly read the row as detached
				// from live infra.
				setPatch.containerId = null
				if (outcome.snapshotKey) {
					setPatch.snapshotPath = outcome.snapshotKey
				}
			}
			if (outcome.usage) {
				if (typeof outcome.usage.inputTokens === 'number') {
					setPatch.inputTokens = sql`COALESCE(${sessions.inputTokens}, 0) + ${outcome.usage.inputTokens}`
				}
				if (typeof outcome.usage.outputTokens === 'number') {
					setPatch.outputTokens = sql`COALESCE(${sessions.outputTokens}, 0) + ${outcome.usage.outputTokens}`
				}
				if (typeof outcome.usage.cacheReadTokens === 'number') {
					setPatch.cacheReadInputTokens = sql`COALESCE(${sessions.cacheReadInputTokens}, 0) + ${outcome.usage.cacheReadTokens}`
				}
				if (typeof outcome.usage.cacheCreationTokens === 'number') {
					setPatch.cacheCreationInputTokens = sql`COALESCE(${sessions.cacheCreationInputTokens}, 0) + ${outcome.usage.cacheCreationTokens}`
				}
				if (typeof outcome.usage.costUsd === 'number') {
					setPatch.totalCostUsd = sql`COALESCE(${sessions.totalCostUsd}, 0) + ${outcome.usage.costUsd}`
				}
			}

			const rows = await tx
				.update(sessions)
				.set(setPatch)
				.where(
					and(
						eq(sessions.id, sessionId),
						notInArray(sessions.status, [
							'completed',
							'failed',
							'timeout',
							'user_stopped',
						]),
					),
				)
				.returning({ id: sessions.id })

			flipped = rows[0]

			if (!flipped) return

			// Domain event — one row per settle. `recordEvent` writes to `events`
			// and (in the same tx) the writer-hook can add lineage; we treat it
			// as a plain audit row here.
			await recordEvent(tx, {
				workspaceId: row.workspaceId,
				actorId: row.actorId,
				action: eventAction,
				entityType: 'session',
				entityId: sessionId,
				data: buildEventData(outcome),
			}).catch((err) => {
				// The tx `.catch` is inside the same commit — the caller's tx will
				// still commit the row transition and we surface the event failure
				// in the warning log, not the SettleResult (the event is
				// reconstructible by the reconciler's own pass).
				logger.warn('settleSession: recordEvent inside tx failed', {
					sessionId,
					action: eventAction,
					error: String(err),
				})
			})
		})
	}

	// Step 4: (Post-commit) stopSandbox best-effort.
	let stoppedSandbox: StoppedSandboxOutcome
	try {
		stoppedSandbox = await deps.stopSandbox(row, outcome)
	} catch (err) {
		logger.warn('settleSession: stopSandbox threw', {
			sessionId,
			source: outcome.source,
			error: String(err),
		})
		stoppedSandbox = 'skipped-error'
	}

	// Step 5: (Post-commit) pushAgentFiles best-effort. Skipped for
	// startup_stalled / dispatch_failure — no learnings or memory were ever
	// written on those paths.
	let pushedAgentFiles: PushedAgentFilesOutcome = 'skipped-no-workspace'
	if (!NO_PUSH_CLASSIFICATIONS.has(outcome.classification)) {
		try {
			pushedAgentFiles = await deps.pushAgentFiles(row, outcome)
		} catch (err) {
			logger.warn('settleSession: pushAgentFiles threw', {
				sessionId,
				classification: outcome.classification,
				error: String(err),
			})
			pushedAgentFiles = 'failed'
		}
	}

	return {
		sessionId,
		finalStatus,
		alreadySettled: wasAlreadyTerminal || !flipped,
		stoppedSandbox,
		pushedAgentFiles,
		// Commit 4 wires the dual-emit; commit 2 preserves the existing
		// `maskin_plan_session_completed` emit at its current session-manager
		// site with unchanged shape and predicate.
		posthogEmitted: false,
		events,
	}
}

/**
 * Merge `outcome` into the session's persisted `result` JSON blob. Preserves
 * every field the row already carries — a re-entry with a later outcome does
 * not clobber the earlier one's `reason`, `resultText`, or `failure_reason`
 * unless the caller explicitly supplied a replacement.
 */
function mergeResultBlob(
	previous: SessionResult | null,
	outcome: SettleOutcome,
): SessionResult {
	const merged: SessionResult = { ...(previous ?? {}) }
	if (outcome.reason !== undefined) merged.error = outcome.reason
	if (outcome.resultText !== undefined) merged.summary = outcome.resultText
	if (outcome.exitCode !== undefined) merged.exit_code = outcome.exitCode
	if (outcome.failureReason !== undefined) merged.failure_reason = outcome.failureReason
	return merged
}

function buildEventData(outcome: SettleOutcome): Record<string, unknown> {
	const data: Record<string, unknown> = {
		classification: outcome.classification,
		source: outcome.source,
	}
	if (outcome.reason !== undefined) data.reason = outcome.reason
	if (outcome.exitCode !== undefined) data.exit_code = outcome.exitCode
	if (outcome.usage !== undefined) data.usage = outcome.usage
	if (outcome.cliReported !== undefined) data.cli_reported = outcome.cliReported
	if (outcome.failureReason !== undefined) {
		data.failure_reason = outcome.failureReason
		if (outcome.failureReason?.reason_code) {
			data.reason_code = outcome.failureReason.reason_code
		}
	}
	return data
}

/**
 * Classify a provider error surfaced during a session run. Stubbed here —
 * commit 4/6 fills in the 402 / 429-with-reset / provider-auth branches
 * once the retryAt seam lands on the trigger-engine side.
 */
export function classifyProviderError(_err: unknown): TerminalClassification | undefined {
	return undefined
}
