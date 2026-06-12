import type { Database } from '@maskin/db'
import { events, sessions } from '@maskin/db/schema'
import type { SessionResultFailureReason } from '@maskin/shared'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { logger } from '../lib/logger'

/**
 * Statuses where the session is supposed to be alive on the agent-server.
 * `paused` is excluded — those sessions are intentionally suspended and have
 * their own restore path. `queued` is excluded — no container assigned yet.
 * `snapshotting` is excluded — handled by the snapshot endpoint, not by boot
 * reconciliation.
 */
const ACTIVE_SANDBOX_STATUSES = ['pending', 'starting', 'running'] as const

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
	/**
	 * UUID of the agent_servers row making the call. v1 is single-host so this
	 * is informational; once `sessions.agent_server_id` lands (T6) the reconcile
	 * will be scoped to sessions owned by this server.
	 */
	agentServerId: string
	/** Sandbox names the agent-server's `msb list` reports as currently present. */
	sandboxes: string[]
}

export interface ReconcileResult {
	/** Session IDs that were marked failed with `agent_server_lost`. */
	markedFailed: string[]
	/** Sandbox names not claimed by any active DB session — caller should `msb remove -f` them. */
	orphanSandboxes: string[]
}

export class SessionReconciler {
	constructor(private db: Database) {}

	async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
		const sandboxSet = new Set(input.sandboxes)

		// Only sessions with a containerId can be mapped to a sandbox name. A
		// `pending` row with no container hasn't been dispatched yet and is the
		// dispatcher's responsibility, not ours.
		const candidates = await this.db
			.select({
				id: sessions.id,
				workspaceId: sessions.workspaceId,
				actorId: sessions.actorId,
				containerId: sessions.containerId,
			})
			.from(sessions)
			.where(
				and(
					inArray(sessions.status, [...ACTIVE_SANDBOX_STATUSES]),
					isNotNull(sessions.containerId),
				),
			)

		const dbContainerIds = new Set<string>()
		const lost: typeof candidates = []
		for (const row of candidates) {
			if (row.containerId === null) continue
			dbContainerIds.add(row.containerId)
			if (!sandboxSet.has(row.containerId)) lost.push(row)
		}

		const orphanSandboxes = input.sandboxes.filter((name) => !dbContainerIds.has(name))

		const markedFailed: string[] = []
		for (const row of lost) {
			try {
				await this.markFailed(row.id, row.workspaceId, row.actorId)
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
			activeSessionsConsidered: candidates.length,
			markedFailedCount: markedFailed.length,
			orphanSandboxesCount: orphanSandboxes.length,
		})

		return { markedFailed, orphanSandboxes }
	}

	private async markFailed(sessionId: string, workspaceId: string, actorId: string): Promise<void> {
		const now = new Date()
		await this.db
			.update(sessions)
			.set({
				status: 'failed',
				result: { exit_code: null, failure_reason: FAILURE_REASON },
				completedAt: now,
				updatedAt: now,
				currentActivity: null,
			})
			.where(eq(sessions.id, sessionId))

		await this.db.insert(events).values({
			workspaceId,
			actorId,
			action: 'session_failed',
			entityType: 'session',
			entityId: sessionId,
			data: { exit_code: null, failure_reason: FAILURE_REASON },
		})
	}
}
