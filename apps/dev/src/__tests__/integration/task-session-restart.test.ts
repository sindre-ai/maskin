// A Developer session that completes while its task is still in progress gets restarted (twice at
// most); a task that moved on, has a live session, or was run by another agent is left alone.

import { randomUUID } from 'node:crypto'
import { events, objects, sessions } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	DEVELOPER_NAME,
	MAX_TASK_RESTARTS,
	RESTART_DELAY_MS,
	TASK_RESTART_KILLSWITCH_ENV_VAR,
	TaskSessionRestarter,
} from '../../services/task-session-restart'
import {
	ensureWorkspaceMember,
	insertActor,
	insertObject,
	insertSession,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { db, getTestActorId } from './global-setup'

const { startSessionMock } = vi.hoisted(() => ({
	startSessionMock: vi.fn(
		async (_input: {
			config?: Record<string, unknown>
			initiatedFromObjectId: string | null
			parentSessionId?: string
		}) => ({ sessionId: '', state: 'queued', createdAt: new Date() }),
	),
}))

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn(async () => undefined),
}))

vi.mock('../../services/session-lifecycle', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../services/session-lifecycle')>()),
	startSession: startSessionMock,
}))

const MINUTE = 60_000

describe('TaskSessionRestarter', () => {
	let workspaceId: string
	let actorId: string
	let developerId: string
	let ctoId: string
	let triggerId: string
	let now: Date

	beforeEach(async () => {
		startSessionMock.mockClear()
		actorId = getTestActorId()
		workspaceId = (await insertWorkspace(db, actorId)).id
		const developer = await insertActor(db, { type: 'agent', name: DEVELOPER_NAME })
		developerId = developer.id
		const cto = await insertActor(db, { type: 'agent', name: 'CTO' })
		await ensureWorkspaceMember(db, workspaceId, cto.id)
		ctoId = cto.id
		triggerId = (await insertTrigger(db, workspaceId, actorId, developerId)).id
		now = new Date()
		// Stand-in for the real startSession: inserts the live row the new session would have.
		startSessionMock.mockImplementation(async (input) => {
			const started = await insertSession(db, workspaceId, developerId, actorId, {
				status: 'running',
				config: input.config ?? {},
				initiatedFromObjectId: input.initiatedFromObjectId,
			})
			return { sessionId: started.id, state: 'queued', createdAt: new Date() }
		})
	})

	const makeTask = (status: string, overrides?: Record<string, unknown>) =>
		insertObject(db, workspaceId, actorId, {
			type: 'task',
			status,
			driver: developerId,
			...overrides,
		})

	// A session that ended `endedMinutesAgo` minutes ago on the task, as the platform creates a
	// trigger-started one: interactive true, with the trigger that started it.
	const endedSession = (
		taskId: string,
		endedMinutesAgo = 10,
		overrides?: Record<string, unknown>,
		sessionActorId = developerId,
	) =>
		insertSession(db, workspaceId, sessionActorId, actorId, {
			status: 'completed',
			interactive: true,
			triggerId,
			initiatedFromObjectId: taskId,
			createdAt: new Date(now.getTime() - (endedMinutesAgo + 20) * MINUTE),
			completedAt: new Date(now.getTime() - endedMinutesAgo * MINUTE),
			...overrides,
		})

	const sweep = (env: NodeJS.ProcessEnv = {}) => new TaskSessionRestarter(db, env).sweep(now)

	const sessionsOnTask = (taskId: string) =>
		db.select().from(sessions).where(eq(sessions.initiatedFromObjectId, taskId))

	it('starts one new session on the same task when the session ended and the task is in progress', async () => {
		const task = await makeTask('in_progress')
		const ended = await endedSession(task.id)

		await sweep()

		expect(startSessionMock).toHaveBeenCalledTimes(1)
		const call = startSessionMock.mock.calls[0][0]
		expect(call.initiatedFromObjectId).toBe(task.id)
		expect(call.parentSessionId).toBe(ended.id)
		expect(call.config?.task_restart).toMatchObject({ of_session_id: ended.id, attempt: 1 })

		// The next tick sees a live session newer than the ended one, so it does not start another.
		await sweep()
		expect(startSessionMock).toHaveBeenCalledTimes(1)
	})

	it.each(['in_review', 'done', 'blocked', 'backlog', 'todo'])(
		'leaves a task in %s alone',
		async (status) => {
			const task = await makeTask(status)
			await endedSession(task.id)

			await sweep()

			expect(startSessionMock).not.toHaveBeenCalled()
		},
	)

	it('waits for the end event to settle before reading the task status', async () => {
		const task = await makeTask('in_progress')
		await endedSession(task.id, RESTART_DELAY_MS / MINUTE - 1)

		await sweep()

		expect(startSessionMock).not.toHaveBeenCalled()
	})

	it('leaves a task alone while a session on it is still running', async () => {
		const task = await makeTask('in_progress')
		await endedSession(task.id)
		await insertSession(db, workspaceId, developerId, actorId, {
			status: 'running',
			initiatedFromObjectId: task.id,
			createdAt: new Date(now.getTime() - 2 * MINUTE),
		})

		await sweep()

		expect(startSessionMock).not.toHaveBeenCalled()
	})

	it('ignores sessions that failed, were stopped, or are a chat', async () => {
		const failed = await makeTask('in_progress')
		await endedSession(failed.id, 10, { status: 'failed' })
		const stopped = await makeTask('in_progress')
		await endedSession(stopped.id, 10, { status: 'user_stopped' })
		const chat = await makeTask('in_progress')
		await endedSession(chat.id, 10, { triggerId: null, config: { conversation: randomUUID() } })

		await sweep()

		expect(startSessionMock).not.toHaveBeenCalled()
	})

	it('leaves alone a session by another agent on a task it drives', async () => {
		const reviewer = await insertActor(db, { type: 'agent', name: 'Code Reviewer' })
		const task = await makeTask('in_progress', { driver: reviewer.id })
		await endedSession(task.id, 10, undefined, reviewer.id)

		await sweep()

		expect(startSessionMock).not.toHaveBeenCalled()
	})

	it('ignores a task driven by someone other than the session agent', async () => {
		const other = await insertActor(db, { type: 'agent', name: 'Code Reviewer' })
		const task = await makeTask('in_progress', { driver: other.id })
		await endedSession(task.id)

		await sweep()

		expect(startSessionMock).not.toHaveBeenCalled()
	})

	it('does nothing when the killswitch is off', async () => {
		const task = await makeTask('in_progress')
		await endedSession(task.id)

		await sweep({ [TASK_RESTART_KILLSWITCH_ENV_VAR]: '0' })

		expect(startSessionMock).not.toHaveBeenCalled()
	})

	it('restarts at most twice, then comments once and mentions the CTO', async () => {
		const task = await makeTask('in_progress')
		await endedSession(task.id)

		// Each restart ends early too: complete the live one a few minutes back and sweep again.
		for (let attempt = 1; attempt <= MAX_TASK_RESTARTS; attempt++) {
			await sweep()
			expect(startSessionMock).toHaveBeenCalledTimes(attempt)
			const [live] = (await sessionsOnTask(task.id)).filter((s) => s.status === 'running')
			await db
				.update(sessions)
				.set({
					status: 'completed',
					createdAt: new Date(now.getTime() - 25 * MINUTE + attempt * MINUTE),
					completedAt: new Date(now.getTime() - 5 * MINUTE),
				})
				.where(eq(sessions.id, live.id))
			// Settling a session clears the task's live-session link; do the same here.
			await db.update(objects).set({ activeSessionId: null }).where(eq(objects.id, task.id))
		}

		await sweep()
		await sweep()

		expect(startSessionMock).toHaveBeenCalledTimes(MAX_TASK_RESTARTS)
		const comments = await db
			.select()
			.from(events)
			.where(
				and(
					eq(events.action, 'commented'),
					eq(events.entityType, 'object'),
					eq(events.entityId, task.id),
				),
			)
		expect(comments).toHaveLength(1)
		expect((comments[0].data as { mentions?: string[] }).mentions).toEqual([ctoId])
	})
})
