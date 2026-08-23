import type { Database, Transaction } from '@maskin/db'
import { events, agentServers, sessions } from '@maskin/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { AgentServerClient } from './agent-server-client'
import type { SessionManager } from './session-manager'

/**
 * Statuses whose session still owns a live sandbox (or a queued dispatch that
 * is about to become one). A superset of the CLAIMED_STATUSES set in
 * session-reconciler.ts: it adds `queued`, which that set deliberately excludes
 * because a queued row has no container yet. Do NOT re-sync the two lists —
 * a row in any of these is not finished with its compute, so deleting it
 * strands whatever is running or is about to be.
 *
 * Being in this list makes a row a *candidate*. Rows with no compute attached
 * yet (no agent-server, no container) are filtered out before a stop is
 * attempted — see the filter in `stopSessionsForActors`.
 */
const LIVE_STATUSES = [
	'pending',
	'queued',
	'starting',
	'running',
	'snapshotting',
	'waiting_for_input',
] as const

/**
 * How long a single stop may take before we give up on it and proceed with the
 * delete anyway. The agent-server is reached over HTTPS and may be unreachable
 * or mid-redeploy; a caller like the loop-uninstall route is deleting a whole
 * set of agents and must not hang on one bad server.
 */
const STOP_TIMEOUT_MS = 10_000

export interface StopSessionsForActorsResult {
	stopped: string[]
	failed: string[]
}

function withTimeout(promise: Promise<void>, ms: number, label: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
		promise.then(
			() => {
				clearTimeout(timer)
				resolve()
			},
			(err) => {
				clearTimeout(timer)
				reject(err)
			},
		)
	})
}

/**
 * Stop every live session belonging to `actorIds` before those actors (and
 * their session rows) are deleted.
 *
 * Deleting an actor cascades to `delete(sessions)`, but the sandbox running on
 * an agent-server has no idea: it keeps executing, keeps holding its
 * `agent_servers` capacity slot until the 2h timeout backstop, and keeps POSTing
 * logs for a `sessions` row that no longer exists — every one of those inserts
 * failing the `session_logs` foreign key. That last part is Sentry MASKIN-DEV-5
 * / MASKIN-AGENT-SERVER-1; the capacity leak and the deleted-agent-still-acting
 * problem are the more serious halves.
 *
 * Deliberately NOT run inside the caller's delete transaction: stopping is an
 * HTTPS call to the agent-server, and holding a write transaction open across a
 * network timeout is worse than the problem being solved. A rollback couldn't
 * un-stop an already-stopped sandbox either.
 *
 * Best-effort by design. A stop that fails is logged and reported, and the
 * caller proceeds with the delete — leaving the actor undeletable because an
 * agent-server is unreachable is a worse user-facing trade than an occasional
 * stranded sandbox, which the reconciler's boot pass cleans up anyway.
 */
export async function stopSessionsForActors(
	db: Database,
	sessionManager: SessionManager,
	actorIds: string[],
	deletedByActorId: string,
): Promise<StopSessionsForActorsResult> {
	if (actorIds.length === 0) return { stopped: [], failed: [] }

	const candidates = await db
		.select({
			id: sessions.id,
			workspaceId: sessions.workspaceId,
			actorId: sessions.actorId,
			agentServerId: sessions.agentServerId,
			containerId: sessions.containerId,
		})
		.from(sessions)
		.where(and(inArray(sessions.actorId, actorIds), inArray(sessions.status, [...LIVE_STATUSES])))

	// A `queued`/`pending` row has been claimed by nothing yet: no agent-server,
	// no container. `SessionManager.stopSession` throws
	// `not found or has no container` for exactly that shape, so attempting a
	// stop would log an error-level (Sentry-visible) line for what is the normal
	// case — an error storm, in the fix meant to end one. Nothing is stranded by
	// skipping them: with no compute attached there is nothing to stop.
	const live = candidates.filter((row) => row.agentServerId !== null || row.containerId !== null)

	if (live.length === 0) return { stopped: [], failed: [] }

	// `Promise.resolve().then(...)` — not a bare `sessionManager.stopSession(...)`
	// — so a *synchronous* throw becomes a rejected promise that
	// `Promise.allSettled` can absorb. Thrown straight out of the `map`
	// callback it would escape `allSettled` entirely and reject this function,
	// turning a best-effort cleanup into a 500 that aborts the caller's delete.
	const outcomes = await Promise.allSettled(
		live.map((row) =>
			withTimeout(
				Promise.resolve().then(() => sessionManager.stopSession(row.id)),
				STOP_TIMEOUT_MS,
				`stopSession ${row.id}`,
			),
		),
	)

	const stopped: string[] = []
	const failed: string[] = []
	for (const [index, outcome] of outcomes.entries()) {
		const row = live[index]
		if (!row) continue
		if (outcome.status === 'fulfilled') {
			stopped.push(row.id)
		} else {
			failed.push(row.id)
			logger.error('Failed to stop a live session before deleting its agent', {
				sessionId: row.id,
				actorId: row.actorId,
				error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
			})
		}
	}

	// The session rows are about to be deleted, so a `failure_reason` on them
	// would never be seen — the audit log is the only surface that outlives the
	// delete, and it's what the workspace activity feed reads.
	//
	// Attributed to the actor performing the delete, NOT to `row.actorId`. Every
	// caller's delete transaction also runs
	// `delete(events).where(eq(events.actorId, <agent being deleted>))`
	// (actors.ts, marketplace-loops.ts), so an event attributed to the agent is
	// wiped milliseconds after it is written and never reaches the feed. The
	// deleted agent is still identifiable from `data.agent_actor_id`.
	if (stopped.length > 0 || failed.length > 0) {
		await db
			.insert(events)
			.values(
				live.map((row) => ({
					workspaceId: row.workspaceId,
					actorId: deletedByActorId,
					action: 'session_failed' as const,
					entityType: 'session' as const,
					entityId: row.id,
					data: {
						exit_code: null,
						source: 'agent_deleted',
						agent_actor_id: row.actorId,
						stopped: stopped.includes(row.id),
						failure_reason: {
							provider: 'agent-server',
							reason_code: 'agent_deleted',
							human_message:
								'This session was stopped because its agent was deleted while the session was still running.',
							http_status: null,
							reset_at: null,
							verbatim_output: null,
						},
					},
				})),
			)
			.catch((err) => {
				// Audit-only — never block the delete on it.
				logger.error('Failed to record stop events for deleted agent sessions', {
					actorIds,
					error: err instanceof Error ? err.message : String(err),
				})
			})
	}

	logger.info('Stopped live sessions ahead of agent deletion', {
		actorIds,
		liveCount: live.length,
		stoppedCount: stopped.length,
		failedCount: failed.length,
	})

	return { stopped, failed }
}

/**
 * A live session captured *inside* a delete transaction, for stopping after it
 * commits.
 *
 * `stopSessionsForActors` can't serve every caller: the loop uninstall route,
 * the marketplace cascade, and the loop version pusher all decide which actors
 * to delete inside their transaction (a shared agent another installed loop
 * still references is kept). Re-deriving that set read-only beforehand risks
 * killing a live session belonging to an agent that turns out to survive.
 *
 * So those callers capture the rows they are about to delete and stop them once
 * the transaction commits. Deleting the row first is not a problem here because
 * a stop only needs the session id and the agent-server to send it to — never
 * the `sessions` row itself, which `SessionManager.stopSession` would re-read
 * and no longer find.
 */
export interface CapturedLiveSession {
	id: string
	agentServerId: string | null
}

/** Select the live sessions for `actorIds` using a transaction handle. */
export async function captureLiveSessions(
	tx: Database | Transaction,
	actorIds: string[],
): Promise<CapturedLiveSession[]> {
	if (actorIds.length === 0) return []
	return tx
		.select({ id: sessions.id, agentServerId: sessions.agentServerId })
		.from(sessions)
		.where(and(inArray(sessions.actorId, actorIds), inArray(sessions.status, [...LIVE_STATUSES])))
}

/**
 * Stop sandboxes for sessions whose rows have already been deleted.
 *
 * Best-effort, same rationale as `stopSessionsForActors` — the delete has
 * already committed, so there is nothing to roll back and nothing to fail.
 * Sessions with no `agentServerId` ran as local Docker containers (dev only);
 * the remote path is the one that leaks production capacity.
 */
export async function stopCapturedSandboxes(
	db: Database,
	captured: CapturedLiveSession[],
): Promise<void> {
	const remote = captured.filter((row) => row.agentServerId !== null)
	if (remote.length === 0) return

	await Promise.allSettled(
		remote.map(async (row) => {
			const [serverRow] = await db
				.select()
				.from(agentServers)
				.where(eq(agentServers.id, row.agentServerId as string))
				.limit(1)
			if (!serverRow) return
			const client = new AgentServerClient({ server: serverRow })
			try {
				await withTimeout(client.stopSession(row.id), STOP_TIMEOUT_MS, `stopSession ${row.id}`)
			} catch (err) {
				logger.error('Failed to stop a stranded sandbox after its session was deleted', {
					sessionId: row.id,
					agentServerId: row.agentServerId,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}),
	)

	logger.info('Stopped stranded sandboxes after agent deletion', {
		sessionCount: remote.length,
	})
}
