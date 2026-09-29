// The only module in `apps/dev/src/**` allowed to write a terminal
// `sessions.status`. Every other call site funnels through `settleSession()`.

import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import type { SessionResult, SettleSource, TerminalOutcomeKind } from '@maskin/shared'
import { and, eq, notInArray, sql } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'

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

const TERMINAL_STATUS_SET: ReadonlySet<string> = new Set(Object.values(TERMINAL_STATUS_BY_KIND))

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

	const wasAlreadyTerminal = TERMINAL_STATUS_SET.has(existing.status)

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
			if (outcome.kind === 'pause' && outcome.snapshotKey) {
				setPatch.snapshotPath = outcome.snapshotKey
			}
			if (outcome.kind !== 'pause') {
				// A non-pause settle empties the current-activity string so the UI
				// stops showing "typing…" for a session that has actually stopped.
				setPatch.currentActivity = null
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
