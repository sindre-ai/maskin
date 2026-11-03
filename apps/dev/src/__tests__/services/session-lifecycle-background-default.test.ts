import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/workspace-scope', () => ({
	assertInWorkspace: vi.fn().mockResolvedValue(undefined),
}))

import { configureSessionLifecycle, startSession } from '../../services/session-lifecycle'

const createSession = vi.fn(async () => ({
	id: 'sess-1',
	sessionState: 'queued',
	createdAt: new Date(),
}))

const base = { workspaceId: 'ws-1', actorId: 'actor-1', callerKind: 'trigger' } as const

const configOfLastCreate = () =>
	(createSession.mock.calls.at(-1) as unknown as [string, { config?: Record<string, unknown> }])[1]
		.config

describe('startSession background default', () => {
	beforeEach(() => {
		createSession.mockClear()
		configureSessionLifecycle({ db: {}, sessionManager: { createSession } } as never)
	})

	it('runs a session with no chat as an interactive session that ends on its result', async () => {
		await startSession({ ...base, initiatedFromObjectId: null })
		expect(configOfLastCreate()).toMatchObject({ interactive: true, stop_on_result: true })
	})

	it('keeps the rest of the config it was given', async () => {
		await startSession({ ...base, config: { runtime: 'codex' }, initiatedFromObjectId: null })
		expect(configOfLastCreate()).toMatchObject({ runtime: 'codex', interactive: true })
	})

	it('leaves a session that belongs to a chat as given', async () => {
		const config = { conversation: { conversation_id: 'c-1' } }
		await startSession({ ...base, config, initiatedFromObjectId: null })
		expect(configOfLastCreate()).toEqual(config)
	})

	it('makes a session interactive even when the caller asked for one-shot', async () => {
		await startSession({ ...base, config: { interactive: false }, initiatedFromObjectId: null })
		expect(configOfLastCreate()).toMatchObject({ interactive: true, stop_on_result: true })
	})
})
