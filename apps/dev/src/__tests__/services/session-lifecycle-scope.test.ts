import { beforeEach, describe, expect, it, type vi } from 'vitest'
import { configureSessionLifecycle, startSession } from '../../services/session-lifecycle'
import { createMockSessionManager, createTestContext } from '../setup'

const wsId = '00000000-0000-0000-0000-000000000001'
const agentId = '00000000-0000-0000-0000-0000000000a1'

describe('startSession workspace guard', () => {
	let sessionManager: ReturnType<typeof createMockSessionManager>
	let mockResults: ReturnType<typeof createTestContext>['mockResults']

	beforeEach(() => {
		sessionManager = createMockSessionManager()
		const ctx = createTestContext()
		mockResults = ctx.mockResults
		configureSessionLifecycle({ db: ctx.db, sessionManager })
		;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: 'session-1',
		})
	})

	function start(callerKind: 'rest' | 'trigger' | 'internal') {
		return startSession({
			workspaceId: wsId,
			actorId: agentId,
			callerKind,
			actionPrompt: 'Do the thing',
			initiatedFromObjectId: null,
		})
	}

	it.each(['rest', 'trigger', 'internal'] as const)(
		'rejects an agent outside the workspace for a %s caller and creates no session',
		async (callerKind) => {
			// No workspace_members row for this agent in this workspace.
			mockResults.select = []

			await expect(start(callerKind)).rejects.toMatchObject({ status: 404 })

			expect(sessionManager.createSession).not.toHaveBeenCalled()
		},
	)

	it('starts the session when the agent is a member', async () => {
		mockResults.select = [{ id: agentId }]

		const handle = await start('internal')

		expect(handle.sessionId).toBe('session-1')
		expect(sessionManager.createSession).toHaveBeenCalledOnce()
	})
})
