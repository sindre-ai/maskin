import { afterEach, describe, expect, it, vi } from 'vitest'

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }))
vi.mock('../../lib/logger', () => ({
	logger: { warn: warnMock, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { configureSessionLifecycle, startSession } from '../../services/session-lifecycle'

function configureWithFailingPoll() {
	const db = {
		select: () => {
			throw new Error('db down')
		},
	}
	const sessionManager = {
		createSession: vi.fn(async () => ({
			id: 'sess-1',
			sessionState: 'queued',
			createdAt: new Date(),
		})),
	}
	configureSessionLifecycle({ db, sessionManager } as never)
}

const input = {
	workspaceId: 'ws-1',
	actorId: 'actor-1',
	await: 'first-response',
} as never

afterEach(() => {
	warnMock.mockClear()
})

describe('startSession awaitResult failure', () => {
	it('logs and raises no unhandled rejection when the caller never reads awaitResult', async () => {
		configureWithFailingPoll()
		const unhandled: unknown[] = []
		const onUnhandled = (reason: unknown) => unhandled.push(reason)
		process.on('unhandledRejection', onUnhandled)
		try {
			await startSession(input)
			await new Promise((r) => setTimeout(r, 20))
		} finally {
			process.off('unhandledRejection', onUnhandled)
		}
		expect(unhandled).toEqual([])
		expect(warnMock).toHaveBeenCalledWith(
			'startSession: awaitResult poll failed',
			expect.objectContaining({ sessionId: 'sess-1', awaitMode: 'first-response' }),
		)
	})

	it('still rejects for a caller that awaits awaitResult', async () => {
		configureWithFailingPoll()
		const handle = await startSession(input)
		await expect(handle.awaitResult).rejects.toThrow('db down')
	})
})
