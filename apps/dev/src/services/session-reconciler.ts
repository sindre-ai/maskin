import type { Database } from '@maskin/db'
import { events, sessions } from '@maskin/db/schema'
import type { SessionResultFailureReason } from '@maskin/shared'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'

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

export class SessionReconciler {
	constructor(private db: Database) {}

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
			claimedSessionsConsidered: candidates.length,
			markedFailedCount: markedFailed.length,
			orphanSandboxesCount: orphanSandboxes.length,
		})

		return { markedFailed, orphanSandboxes }
	}

	private async markFailed(sessionId: string, workspaceId: string, actorId: string): Promise<void> {
		const now = new Date()
		const [updated] = await this.db
			.update(sessions)
			.set({
				status: 'failed',
				result: { exit_code: null, failure_reason: FAILURE_REASON },
				completedAt: now,
				updatedAt: now,
				currentActivity: null,
			})
			.where(
				and(eq(sessions.id, sessionId), sql`${sessions.status} NOT IN ('completed', 'failed')`),
			)
			.returning({ id: sessions.id })

		if (!updated) return

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
