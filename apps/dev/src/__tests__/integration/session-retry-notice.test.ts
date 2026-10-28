// A chat session that ends on a usage limit gets its "tried again at" note the moment it
// settles, and its answer lands in the same chat once the reset has passed.

import { messages, sessions } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { settleSession } from '../../services/session-lifecycle'
import { SessionRetryScheduler } from '../../services/session-retry-scheduler'
import { insertConversation, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const { startSessionMock } = vi.hoisted(() => ({
	startSessionMock: vi.fn(async () => ({
		sessionId: '00000000-0000-4000-8000-0000000000aa',
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

const deps = {
	db,
	stopSandbox: async () => 'local' as const,
	pushAgentFiles: async () => 'ok' as const,
}

describe('limit hit in a chat: notice at settle, answer after the reset', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		startSessionMock.mockClear()
		actorId = getTestActorId()
		workspaceId = (await insertWorkspace(db, actorId)).id
	})

	it('posts the note as a system message right away, then reruns into the same conversation', async () => {
		const conversation = await insertConversation(db, workspaceId, actorId)
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			conversationId: conversation.id,
		})
		const retryAt = new Date(Date.now() + 2 * 60 * 60_000)

		await settleSession(
			session.id,
			{ kind: 'fail', classification: 'credit_exhaustion', source: 'sandbox-exit', retryAt },
			deps,
		)

		const posted = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, conversation.id))
		expect(posted).toHaveLength(1)
		expect(posted[0].kind).toBe('system')
		expect(posted[0].content).toContain(retryAt.toISOString().slice(11, 16))
		expect(startSessionMock).not.toHaveBeenCalled()

		// Nothing is rerun before the reset...
		const scheduler = new SessionRetryScheduler(db, {} as NodeJS.ProcessEnv)
		await scheduler.tick(new Date(retryAt.getTime() - 60_000))
		expect(startSessionMock).not.toHaveBeenCalled()

		// ...and once it has passed, the rerun answers in the same chat.
		await scheduler.tick(new Date(retryAt.getTime() + 60_000))
		expect(startSessionMock).toHaveBeenCalledTimes(1)
		const call = startSessionMock.mock.calls[0][0]
		expect(call.conversationId).toBe(conversation.id)
		expect(call.retryOf).toBe(session.id)

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row.retriedSessionId).toBe('00000000-0000-4000-8000-0000000000aa')
	})

	it('posts nothing for a limit hit with no chat', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, { status: 'running' })
		await settleSession(
			session.id,
			{
				kind: 'fail',
				classification: 'credit_exhaustion',
				source: 'sandbox-exit',
				retryAt: new Date(Date.now() + 60 * 60_000),
			},
			deps,
		)
		expect(await db.select().from(messages)).toHaveLength(0)
	})
})
