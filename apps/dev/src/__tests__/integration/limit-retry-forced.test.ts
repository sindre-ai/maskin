// Forced-limit proof: a chat session ends on a real Claude limit banner. The banner goes through
// the real classifier, the real retry-time rule and settleSession; the scheduler tick (fake clock)
// then reruns it. Covers a weekly banner with a reset, a session banner with none, and a weekly
// banner with none (which must not be blind-retried).

import { messages, sessions } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifySessionExit } from '../../lib/credit-classifier'
import { pickRetryAt } from '../../lib/subscription-limit-reset'
import { settleSession } from '../../services/session-lifecycle'
import { SessionRetryScheduler } from '../../services/session-retry-scheduler'
import { insertConversation, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const { startSessionMock } = vi.hoisted(() => ({
	startSessionMock: vi.fn(async () => ({
		sessionId: '00000000-0000-4000-8000-0000000000bb',
		state: 'queued',
		createdAt: new Date(),
	})),
}))

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn(async () => undefined),
}))

vi.mock('../../services/session-lifecycle', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../services/session-lifecycle')>()),
	startSession: startSessionMock,
}))

// db is a live binding set in global-setup beforeAll, so read it when settling, not at import.
const makeDeps = () => ({
	db,
	stopSandbox: async () => 'local' as const,
	pushAgentFiles: async () => 'ok' as const,
})

// The recorded weekly banner from 26-28 Oct 2026, and a session-limit banner without a reset.
const WEEKLY_WITH_RESET =
	'{"type":"result","is_error":true,"result":"You\'ve hit your weekly limit · resets Oct 31, 2pm (Europe/Copenhagen)"}'
const SESSION_NO_RESET =
	'{"type":"result","is_error":true,"result":"You\'ve hit your session limit"}'
const WEEKLY_NO_RESET = '{"type":"result","is_error":true,"result":"You\'ve hit your weekly limit"}'

describe('forced limit: banner -> classifier -> settle -> scheduler tick', () => {
	const now = new Date('2026-10-28T06:00:00Z')
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(now)
		startSessionMock.mockClear()
		actorId = getTestActorId()
		workspaceId = (await insertWorkspace(db, actorId)).id
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	async function forceLimit(banner: string) {
		const conversation = await insertConversation(db, workspaceId, actorId)
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			conversationId: conversation.id,
		})
		const reason = classifySessionExit(banner, 1)
		const retryAt = pickRetryAt(reason)
		await settleSession(
			session.id,
			{
				kind: 'fail',
				classification: 'credit_exhaustion',
				source: 'sandbox-exit',
				retryAt: retryAt ?? undefined,
				failureReason: reason,
			},
			makeDeps(),
		)
		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		const notices = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, conversation.id))
		return { session, conversation, reason, row, notices }
	}

	it('weekly banner with a reset time: retry_at is the reset, notice at settle, rerun after it', async () => {
		const { session, conversation, reason, row, notices } = await forceLimit(WEEKLY_WITH_RESET)
		expect(reason?.reason_code).toBe('weekly_limit')
		expect(row.retryAt?.toISOString()).toBe('2026-10-31T13:00:00.000Z')
		expect(notices).toHaveLength(1)
		expect(notices[0].kind).toBe('system')
		expect(notices[0].content).toContain('Oct 31, 13:00 UTC')

		const scheduler = new SessionRetryScheduler(db, {} as NodeJS.ProcessEnv)
		await scheduler.tick(new Date('2026-10-31T12:59:00Z'))
		expect(startSessionMock).not.toHaveBeenCalled()
		await scheduler.tick(new Date('2026-10-31T13:01:00Z'))
		expect(startSessionMock).toHaveBeenCalledTimes(1)
		expect(startSessionMock.mock.calls[0][0].conversationId).toBe(conversation.id)
		const [after] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(after.retriedSessionId).toBe('00000000-0000-4000-8000-0000000000bb')
	})

	it('session banner with no reset time: retry_at is 30 minutes out, notice at settle, rerun then', async () => {
		const { session, conversation, reason, row, notices } = await forceLimit(SESSION_NO_RESET)
		expect(reason?.reason_code).toBe('session_limit')
		expect(reason?.reset_at).toBeNull()
		expect(row.retryAt?.toISOString()).toBe('2026-10-28T06:30:00.000Z')
		expect(notices).toHaveLength(1)
		expect(notices[0].content).toContain('06:30 UTC')

		const scheduler = new SessionRetryScheduler(db, {} as NodeJS.ProcessEnv)
		await scheduler.tick(new Date('2026-10-28T06:29:00Z'))
		expect(startSessionMock).not.toHaveBeenCalled()
		await scheduler.tick(new Date('2026-10-28T06:31:00Z'))
		expect(startSessionMock).toHaveBeenCalledTimes(1)
		expect(startSessionMock.mock.calls[0][0].conversationId).toBe(conversation.id)
		const [after] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(after.retriedSessionId).toBe('00000000-0000-4000-8000-0000000000bb')
	})

	it('weekly banner with no reset time: no retry_at, no notice, nothing rerun', async () => {
		const { reason, row, notices } = await forceLimit(WEEKLY_NO_RESET)
		expect(reason?.reason_code).toBe('weekly_limit')
		expect(row.retryAt).toBeNull()
		expect(notices).toHaveLength(0)

		await new SessionRetryScheduler(db, {} as NodeJS.ProcessEnv).tick(
			new Date('2026-10-28T09:00:00Z'),
		)
		expect(startSessionMock).not.toHaveBeenCalled()
	})
})
