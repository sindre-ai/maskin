// The only module in `apps/dev/src/**` allowed to write a terminal
// `sessions.status`. Every other call site funnels through `settleSession()`.
// Commit 1 lands the API surface + side-effect ordering; commit 2 wires the
// call-site migration and the actual implementations.

import type { SettleSource, TerminalOutcomeKind } from '@maskin/shared'

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
	}
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
 * Public accessor so call-sites and tests never re-encode the mapping. This is
 * the only export that reads the constant; keeping it a function rather than a
 * re-export lets the guard test's AST scan continue to have exactly zero
 * `status: 'completed'`-style property assignments in this file (the assignment
 * lives inside `TERMINAL_STATUS_BY_KIND` above, which the guard test allows
 * because the file matches the `ALLOW` path).
 */
export function mapKindToFinalStatus(kind: TerminalOutcomeKind): FinalStatus {
	return TERMINAL_STATUS_BY_KIND[kind]
}

/**
 * settleSession — the only writer of a terminal `sessions.status`.
 *
 * Commit 1 ships the signature and the side-effect skeleton; commit 2 wires
 * every call site through it and fleshes each step out. The comments below
 * describe the ordering the implementation will follow so a reader can verify
 * commit 2 preserves it.
 *
 * Ordered side-effects (per spec §1.5):
 *   1. Conditional UPDATE sessions — reserves the row.
 *      `WHERE status NOT IN ('completed','failed','timeout','user_stopped')`.
 *      A row already in a terminal state returns `alreadySettled: true` and
 *      settle STILL runs the idempotent side-effects (stopSandbox
 *      best-effort, pushAgentFiles best-effort with `overwrite:true`, PostHog
 *      gated by a per-session dedupe key) but does NOT overwrite the row.
 *   2. Insert an `events` row (`type: 'session_settled'`, `data: outcome`
 *      minus `resultText`).
 *   3. (after commit) stopSandbox(session, outcome.source) — §2.
 *   4. pushAgentFiles(session) — §7 (skip on `startup_stalled` and
 *      `dispatch_failure`).
 *   5. Emit `session_timeout` / `session_failed` / `session_completed` /
 *      `session_stopped` / `session_paused` — the reaper- and trigger-visible
 *      rows in the `events` table.
 *   6. emitPostHogCompletion(session, outcome) — commit 4 delivers this as a
 *      dual-emit sub-task; commit 1's skeleton emits nothing.
 *
 * Error semantics (§1.6): throws ONLY when the pre-commit UPDATE errors (DB
 * unreachable). Post-commit failures surface through `SettleResult` fields
 * (`stoppedSandbox: 'skipped-error'`, `pushedAgentFiles: 'failed'`,
 * `posthogEmitted: false`) so callers can log context without retrying the
 * terminal write.
 */
export async function settleSession(
	sessionId: string,
	_outcome: SettleOutcome,
): Promise<SettleResult> {
	// Commit 2 replaces this body. The scaffold intentionally throws so nothing
	// on `main` accidentally routes through settle before the migration commit
	// wires it in — a silent no-op here would let a call-site's terminal write
	// simply disappear.
	throw new Error(
		`settleSession(${sessionId}) not yet implemented — commit 2 wires call sites and the row-write path`,
	)
}

/**
 * Classify a provider error surfaced during a session run. Commit 1 stubs it
 * out (returns `undefined` — caller falls back to `'sandbox_crash'` or
 * whatever classification the current path uses); commit 2 fills in the 402 /
 * 429-with-reset / provider-auth branches per §9.1.
 *
 * This helper does NOT implement retry — that belongs to bet #0 ("waiting is
 * waiting"). Its sole job is to classify accurately so the reset time recorded
 * downstream is trustworthy.
 */
export function classifyProviderError(_err: unknown): TerminalClassification | undefined {
	return undefined
}
