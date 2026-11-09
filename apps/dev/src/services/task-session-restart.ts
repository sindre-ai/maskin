/**
 * task-session-restart.ts — restarts an agent session that ended early while its task is still
 * in progress.
 *
 * A session that settles as `completed` while the task it was driving is still `in_progress`
 * did not finish the work (it closed on a promise, e.g. "I'll check once the server is up").
 * Nothing else wakes such a task, so it sat for hours with nobody on it. Waiting on a person
 * belongs in `blocked`, so `in_progress` with no live session is the only signal used here.
 *
 * Called from SessionRetryScheduler's 30 second tick (no extra cron). For each candidate:
 *   - the session completed at least RESTART_DELAY_MS ago, so the agent's last status change
 *     (which can land after the end event) has been read, not raced;
 *   - it was started for a task whose driver is the session's own agent, and the task is still
 *     `in_progress` with no live session on it;
 *   - a restart is one fresh session on the same task, marked in its config so the cap
 *     (MAX_TASK_RESTARTS) is counted from the task's own sessions and survives a server restart;
 *   - at the cap, one comment mentions the CTO and nothing more is started.
 *
 * Killswitch env FEATURE_TASK_SESSION_RESTART=0. Default ON.
 */

import { type AnyColumn, type SQL, and, sql as drizzleSql, eq, gte, lte } from 'drizzle-orm'

import type { Database } from '@maskin/db'
import { events, actors, objects, sessions, workspaceMembers } from '@maskin/db/schema'

import { postComment } from '../lib/comments'
import { logger } from '../lib/logger'
import { TERMINAL_STATUSES, startSession } from './session-lifecycle'

export const TASK_RESTART_KILLSWITCH_ENV_VAR = 'FEATURE_TASK_SESSION_RESTART'
export const MAX_TASK_RESTARTS = 2
/** Wait this long after the end event before reading the task status. */
export const RESTART_DELAY_MS = 3 * 60_000
/** Sessions that ended longer ago than this are left alone (an outage or deploy must not revive old tasks). */
export const RESTART_WINDOW_MS = 60 * 60_000
export const CTO_NAME = 'CTO'
const BATCH_LIMIT = 50

type Candidate = {
	id: string
	workspaceId: string
	actorId: string
	triggerId: string | null
	taskId: string
	taskTitle: string
}

export class TaskSessionRestarter {
	constructor(
		private db: Database,
		private env: NodeJS.ProcessEnv = process.env,
	) {}

	async sweep(now: Date = new Date()): Promise<void> {
		if (this.env[TASK_RESTART_KILLSWITCH_ENV_VAR] === '0') return

		const candidates = await this.findCandidates(now)
		for (const candidate of candidates) {
			await this.handleOne(candidate).catch((err) =>
				logger.error('TaskSessionRestarter.handleOne failed', {
					sessionId: candidate.id,
					taskId: candidate.taskId,
					error: String(err),
				}),
			)
		}
	}

	private async findCandidates(now: Date): Promise<Candidate[]> {
		return this.db
			.select({
				id: sessions.id,
				workspaceId: sessions.workspaceId,
				actorId: sessions.actorId,
				triggerId: sessions.triggerId,
				taskId: objects.id,
				taskTitle: objects.title,
			})
			.from(sessions)
			.innerJoin(objects, eq(objects.id, sessions.initiatedFromObjectId))
			.where(
				and(
					eq(sessions.status, 'completed'),
					eq(sessions.interactive, false),
					gte(sessions.completedAt, new Date(now.getTime() - RESTART_WINDOW_MS)),
					lte(sessions.completedAt, new Date(now.getTime() - RESTART_DELAY_MS)),
					eq(objects.type, 'task'),
					eq(objects.status, 'in_progress'),
					eq(objects.driver, sessions.actorId),
					drizzleSql`${objects.activeSessionId} IS NULL`,
					noNewerOrLiveSession(sessions.id, sessions.createdAt, sessions.actorId, objects.id),
				),
			)
			.orderBy(sessions.completedAt)
			.limit(BATCH_LIMIT)
	}

	private async handleOne(candidate: Candidate): Promise<void> {
		// One instance handles a session at a time (blue-green deploys run two). The lock is held
		// to the end of this transaction, and the recheck inside it sees whatever the winner started.
		await this.db.transaction(async (tx) => {
			const [{ locked }] = (await tx.execute(
				drizzleSql`SELECT pg_try_advisory_xact_lock(hashtext(${`task-session-restart:${candidate.id}`})) AS locked`,
			)) as unknown as Array<{ locked: boolean }>
			if (!locked) return

			const [row] = await tx
				.select({ status: objects.status, activeSessionId: objects.activeSessionId })
				.from(objects)
				.where(eq(objects.id, candidate.taskId))
				.limit(1)
			if (!row || row.status !== 'in_progress' || row.activeSessionId) return

			const [{ owned }] = (await tx.execute(
				drizzleSql`SELECT NOT (${noNewerOrLiveSession(
					drizzleSql`${candidate.id}::uuid`,
					drizzleSql`(SELECT created_at FROM sessions WHERE id = ${candidate.id})`,
					drizzleSql`${candidate.actorId}::uuid`,
					drizzleSql`${candidate.taskId}::uuid`,
				)}) AS owned`,
			)) as unknown as Array<{ owned: boolean }>
			if (owned) return

			const [{ restarts }] = (await tx.execute(
				drizzleSql`SELECT count(*)::int AS restarts FROM sessions
					WHERE initiated_from_object_id = ${candidate.taskId}
					AND config -> 'task_restart' IS NOT NULL`,
			)) as unknown as Array<{ restarts: number }>

			if (restarts >= MAX_TASK_RESTARTS) {
				await this.reportCap(tx, candidate, restarts)
				return
			}

			const attempt = restarts + 1
			const handle = await startSession({
				workspaceId: candidate.workspaceId,
				actorId: candidate.actorId,
				callerKind: 'internal',
				actionPrompt: restartPrompt(candidate, attempt),
				config: { task_restart: { of_session_id: candidate.id, attempt } },
				triggerId: candidate.triggerId ?? undefined,
				initiatedFromObjectId: candidate.taskId,
				// Restore the ended session's /agent folder (checkout, branch); missing snapshot starts fresh.
				parentSessionId: candidate.id,
			})

			await tx.insert(events).values({
				workspaceId: candidate.workspaceId,
				actorId: candidate.actorId,
				action: 'task_session_restarted',
				entityType: 'session',
				entityId: candidate.id,
				data: { taskId: candidate.taskId, restartedSessionId: handle.sessionId, attempt },
			})
			// The new session is the task's live one; the trigger path links it the same way.
			await this.db
				.update(objects)
				.set({ activeSessionId: handle.sessionId, updatedAt: new Date() })
				.where(
					and(eq(objects.id, candidate.taskId), drizzleSql`${objects.activeSessionId} IS NULL`),
				)
		})
	}

	/** Posts the one "stopped restarting" comment per ended session, then leaves the task alone. */
	private async reportCap(
		tx: Parameters<Parameters<Database['transaction']>[0]>[0],
		candidate: Candidate,
		restarts: number,
	): Promise<void> {
		const [already] = await tx
			.select({ id: events.id })
			.from(events)
			.where(
				and(
					eq(events.action, 'task_session_restart_capped'),
					eq(events.entityType, 'session'),
					eq(events.entityId, candidate.id),
				),
			)
			.limit(1)
		if (already) return

		await tx.insert(events).values({
			workspaceId: candidate.workspaceId,
			actorId: candidate.actorId,
			action: 'task_session_restart_capped',
			entityType: 'session',
			entityId: candidate.id,
			data: { taskId: candidate.taskId, restarts },
		})

		const [cto] = await tx
			.select({ actorId: workspaceMembers.actorId })
			.from(workspaceMembers)
			.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
			.where(
				and(
					eq(workspaceMembers.workspaceId, candidate.workspaceId),
					eq(actors.name, CTO_NAME),
					eq(actors.type, 'agent'),
				),
			)
			.orderBy(actors.createdAt)
			.limit(1)

		await postComment(tx, {
			workspaceId: candidate.workspaceId,
			actorId: candidate.actorId,
			entityId: candidate.taskId,
			content: `${cto ? '@CTO ' : ''}This task is still in progress with nobody on it. Its session ended early and the platform already restarted it ${restarts} times, so it will not restart again. Someone needs to pick it up or move it to blocked.`,
			mentions: cto ? [cto.actorId] : undefined,
			attention: 4,
		})
	}
}

/**
 * True when nothing newer owns the task: no session by the same agent started after this one
 * ended (a restart, or the agent's own follow-up), and no session on the task is still live.
 */
function noNewerOrLiveSession(
	sessionId: SQL | AnyColumn,
	createdAt: SQL | AnyColumn,
	actorId: SQL | AnyColumn,
	taskId: SQL | AnyColumn,
): SQL {
	const terminal = drizzleSql.join(
		TERMINAL_STATUSES.map((s) => drizzleSql`${s}`),
		drizzleSql`, `,
	)
	return drizzleSql`NOT EXISTS (
		SELECT 1 FROM sessions n
		WHERE n.initiated_from_object_id = ${taskId}
		AND n.id <> ${sessionId}
		AND ((n.created_at > ${createdAt} AND n.actor_id = ${actorId}) OR n.status NOT IN (${terminal}))
	)`
}

function restartPrompt(candidate: Candidate, attempt: number): string {
	return `Your earlier session on the task "${candidate.taskTitle}" (${candidate.taskId}) ended while the task is still in progress. This is automatic restart ${attempt} of ${MAX_TASK_RESTARTS}.

Read the task and its comments, find what already exists (branch, pull request, last comment), and continue from there instead of starting over. Do not end your turn on a promise: finish the work and move the task to in_review, or move it to blocked with a comment saying what you need.`
}
