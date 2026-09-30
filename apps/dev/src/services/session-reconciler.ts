import type { Database } from '@maskin/db'
import { events, sessions } from '@maskin/db/schema'
import type { SessionResultFailureReason } from '@maskin/shared'
import { and, asc, eq, inArray, isNotNull, lt } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { type SettleDependencies, settleSession } from './session-lifecycle'

/**
 * Statuses where the session is supposed to be actively running on the
 * agent-server, so a missing sandbox means the work was lost and the row
 * should be marked `failed`. `paused`/`queued` are excluded (no live
 * container). `snapshotting`/`waiting_for_input` are excluded from *failing*
 * — they have their own lifecycle paths — but they DO still hold a live
 * sandbox, so they must count as claiming it (see CLAIMED_STATUSES).
 */
const FAILABLE_STATUSES = ['pending', 'starting', 'running'] as const

/**
 * Statuses whose `containerId` maps to a sandbox that is still expected to be
 * present on the agent-server. A reported sandbox owned by one of these rows is
 * NOT an orphan even when the row isn't eligible to be failed — otherwise the
 * caller would `msb remove -f` a live, mid-snapshot or input-waiting sandbox.
 * `paused` is excluded because it nulls `containerId`; `queued` never has one.
 */
const CLAIMED_STATUSES = [
	'pending',
	'starting',
	'running',
	'snapshotting',
	'waiting_for_input',
] as const

const FAILABLE_STATUS_SET: ReadonlySet<string> = new Set(FAILABLE_STATUSES)

/**
 * The five terminal statuses settleSession writes, paired with the
 * `events.action` string §8.2 says each row must emit. The self-heal check
 * (§9.4) uses this to find terminal-status sessions that never got their
 * `session_*` audit row and back-fill it idempotently.
 */
const TERMINAL_STATUS_TO_EVENT_ACTION = {
	completed: 'session_completed',
	failed: 'session_failed',
	timeout: 'session_timeout',
	user_stopped: 'session_stopped',
	paused: 'session_paused',
} as const

const TERMINAL_STATUSES = Object.keys(TERMINAL_STATUS_TO_EVENT_ACTION) as Array<
	keyof typeof TERMINAL_STATUS_TO_EVENT_ACTION
>

/** §9.4: a session's terminal-status transition must have an events row within this window. */
export const SELF_HEAL_GRACE_MS = 60_000

/**
 * Default batch bound for the §9.4 self-heal pass. Caps how many stale-terminal
 * rows one tick considers before returning — a runaway backlog after a
 * multi-hour outage still gets a bounded pass instead of one giant SELECT that
 * ties up the reconciler cron. Callers can override for tests or a one-off
 * back-fill sweep.
 */
export const SELF_HEAL_DEFAULT_LIMIT = 500

const FAILURE_REASON: SessionResultFailureReason = {
	provider: 'agent-server',
	reason_code: 'agent_server_lost',
	human_message:
		'The agent server restarted and the microsandbox running this session was lost. Start a new session to retry.',
	http_status: null,
	reset_at: null,
	verbatim_output: null,
}

export interface ReconcileInput {
	/** UUID of the agent_servers row making the call. Only sessions owned by this server are considered. */
	agentServerId: string
	/** Sandbox names the agent-server's `msb list` reports as currently present. */
	sandboxes: string[]
}

export interface ReconcileResult {
	/** Session IDs that were marked failed with `agent_server_lost`. */
	markedFailed: string[]
	/** Sandbox names not claimed by any non-terminal DB session — caller should `msb remove -f` them. */
	orphanSandboxes: string[]
}

export interface SelfHealResult {
	/** How many stale-terminal candidates the check considered on this pass. */
	staleConsidered: number
	/** Sessions whose missing `events` row was back-filled. */
	backFilled: Array<{ sessionId: string; action: string }>
}

export class SessionReconciler {
	/**
	 * @param appendSystemLog Appends a `system`-stream line to a session's
	 * transcript (SessionManager's insertSystemLog). Optional and best-effort.
	 * The `failure_reason` written below only renders in the session detail
	 * panel; a user watching the live log stream of a session whose sandbox was
	 * lost otherwise sees it stop mid-sentence with no explanation.
	 */
	private readonly settleDeps: SettleDependencies

	constructor(
		private db: Database,
		private appendSystemLog?: (sessionId: string, content: string) => Promise<void>,
	) {
		// Reconciler-owned sessions never have a live sandbox by definition (their
		// agent-server restarted and lost them); stop is always a no-op. Push is
		// skipped by settleSession's classification guard for `sandbox_crash`
		// anyway — the check-in is here so the intent is legible.
		this.settleDeps = {
			db: this.db,
			stopSandbox: async () => 'skipped-none-live',
			pushAgentFiles: async () => 'skipped-no-workspace',
		}
	}

	async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
		const sandboxSet = new Set(input.sandboxes)

		// Pull every non-terminal session that still holds a containerId. Rows in
		// CLAIMED_STATUSES (including snapshotting / waiting_for_input) own their
		// sandbox name so it isn't mistaken for an orphan; only the FAILABLE subset
		// is eligible to be marked failed when its sandbox is gone.
		const candidates = await this.db
			.select({
				id: sessions.id,
				workspaceId: sessions.workspaceId,
				actorId: sessions.actorId,
				containerId: sessions.containerId,
				status: sessions.status,
			})
			.from(sessions)
			.where(
				and(
					eq(sessions.agentServerId, input.agentServerId),
					inArray(sessions.status, [...CLAIMED_STATUSES]),
					isNotNull(sessions.containerId),
				),
			)

		const dbContainerIds = new Set<string>()
		const lost: typeof candidates = []
		for (const row of candidates) {
			if (row.containerId === null) continue
			// Every claimed row's container counts toward "the DB knows this sandbox",
			// so it's never force-removed as an orphan.
			dbContainerIds.add(row.containerId)
			// Only failable rows whose sandbox vanished get marked failed.
			if (FAILABLE_STATUS_SET.has(row.status) && !sandboxSet.has(row.containerId)) lost.push(row)
		}

		const orphanSandboxes = input.sandboxes.filter((name) => !dbContainerIds.has(name))

		const markedFailed: string[] = []
		for (const row of lost) {
			try {
				await this.markFailed(row.id)
				markedFailed.push(row.id)
			} catch (err) {
				logger.error('Failed to mark session as agent_server_lost', {
					sessionId: row.id,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}

		logger.info('Agent-server reconcile pass complete', {
			agentServerId: input.agentServerId,
			sandboxesReported: input.sandboxes.length,
			claimedSessionsConsidered: candidates.length,
			markedFailedCount: markedFailed.length,
			orphanSandboxesCount: orphanSandboxes.length,
		})

		return { markedFailed, orphanSandboxes }
	}

	/**
	 * §9.4 self-heal check — asserts every terminal-status session has a
	 * matching `events` row within `SELF_HEAL_GRACE_MS`. When missing, inserts
	 * the row via `recordEvent(...)` idempotently. The events row is the
	 * downstream contract for "this session ended" — a missing row leaves
	 * consumers (SSE feed, per-actor completion listeners, PostHog dedupe
	 * upstream) reading the session as silently vanished, so the back-fill is
	 * the load-bearing part of the self-heal.
	 *
	 * Scope — intentional narrowing vs. §9.4's original AC:
	 *
	 *   Post-commit side-effects (stopSandbox, pushAgentFiles overwrite:true,
	 *   PostHog dedupe) are OUT of this method. At t + graceMs the sandbox is
	 *   almost always dead, so `stopSandbox` would resolve `skipped-none-live`
	 *   with no useful state change. `pushAgentFiles` needs per-session
	 *   ContainerManager/AgentServerClient context the reconciler cron doesn't
	 *   hold. PostHog dedupe is already guarded upstream by settleSession's
	 *   CAS-won flag (`flipped`), so a re-emit here would either double-fire
	 *   (no dedupe key on the cron path) or skip idempotently — neither adds
	 *   observability. The missing events row is the one observable failure
	 *   that breaks SSE and per-actor completion listeners today, so this
	 *   method fixes that one and nothing else. See task escalation to Planner.
	 *
	 * Bounded by `limit` (defaults to `SELF_HEAL_DEFAULT_LIMIT`, 500) with
	 * `completedAt ASC` so a large backlog after a multi-hour outage still
	 * drains in stable oldest-first order across successive ticks.
	 *
	 * Idempotent by construction: only sessions with no matching action-typed
	 * events row are back-filled, so a re-run does nothing.
	 */
	async selfHealTerminalWithoutEvents(
		nowMs: number = Date.now(),
		graceMs: number = SELF_HEAL_GRACE_MS,
		limit: number = SELF_HEAL_DEFAULT_LIMIT,
	): Promise<SelfHealResult> {
		const cutoff = new Date(nowMs - graceMs)

		const stale = await this.db
			.select({
				id: sessions.id,
				workspaceId: sessions.workspaceId,
				actorId: sessions.actorId,
				status: sessions.status,
				completedAt: sessions.completedAt,
			})
			.from(sessions)
			.where(
				and(
					inArray(sessions.status, [...TERMINAL_STATUSES]),
					isNotNull(sessions.completedAt),
					lt(sessions.completedAt, cutoff),
				),
			)
			.orderBy(asc(sessions.completedAt))
			.limit(limit)

		const backFilled: Array<{ sessionId: string; action: string }> = []

		for (const row of stale) {
			const status = row.status as keyof typeof TERMINAL_STATUS_TO_EVENT_ACTION
			const expectedAction = TERMINAL_STATUS_TO_EVENT_ACTION[status]

			// Reject any impossible row shape defensively — a status value not in
			// the table means someone widened the terminal set without updating
			// this method; back-filling with a guessed action would corrupt the
			// audit stream, so leave it and log.
			if (!expectedAction) {
				logger.warn('self-heal: unknown terminal status; skipping', {
					sessionId: row.id,
					status: row.status,
				})
				continue
			}

			const [existing] = await this.db
				.select({ id: events.id })
				.from(events)
				.where(
					and(
						eq(events.entityType, 'session'),
						eq(events.entityId, row.id),
						eq(events.action, expectedAction),
					),
				)
				.limit(1)

			if (existing) continue

			try {
				await recordEvent(this.db, {
					workspaceId: row.workspaceId,
					actorId: row.actorId,
					action: expectedAction,
					entityType: 'session',
					entityId: row.id,
					data: {
						classification: 'self_heal',
						source: 'reconciler',
						reason: `self-heal: terminal status ${status} carried no events row`,
					},
				})
				backFilled.push({ sessionId: row.id, action: expectedAction })
			} catch (err) {
				logger.error('self-heal: failed to back-fill missing events row', {
					sessionId: row.id,
					action: expectedAction,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}

		if (backFilled.length > 0) {
			logger.info('Session self-heal pass complete', {
				staleConsidered: stale.length,
				backFilledCount: backFilled.length,
			})
		}

		return { staleConsidered: stale.length, backFilled }
	}

	private async markFailed(sessionId: string): Promise<void> {
		// settleSession is the only writer of `sessions.status` for terminal
		// values. It runs the conditional UPDATE (CAS on non-terminal), inserts
		// the `session_failed` audit row, and returns `alreadySettled: true` on
		// a raced write — same behaviour as the previous inline pattern, minus
		// the duplicate write path the guard test now forbids.
		const settled = await settleSession(
			sessionId,
			{
				kind: 'fail',
				classification: 'sandbox_crash',
				source: 'reconciler',
				reason: FAILURE_REASON.human_message,
				exitCode: 0,
				failureReason: FAILURE_REASON,
			},
			this.settleDeps,
		)

		// A CAS miss (`alreadySettled`) means another writer beat us to it —
		// skip the system-log append, matching the pre-migration return semantics.
		if (settled.alreadySettled) return

		if (this.appendSystemLog) {
			try {
				await this.appendSystemLog(sessionId, FAILURE_REASON.human_message)
			} catch (err) {
				// Never let a log write undo the failed-marking above — a session
				// left non-terminal holds its capacity slot until the timeout
				// backstop, which is strictly worse than a missing log line.
				logger.warn('Failed to append agent_server_lost log line', {
					sessionId,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}
	}
}
