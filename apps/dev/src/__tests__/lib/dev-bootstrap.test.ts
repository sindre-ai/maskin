import { afterEach, describe, expect, it, vi } from 'vitest'
import { maybeBootstrapDev } from '../../lib/dev-bootstrap'
import { createTestContext } from '../setup'

describe('maybeBootstrapDev', () => {
	const originalEnv = { ...process.env }

	afterEach(() => {
		process.env = { ...originalEnv }
		vi.restoreAllMocks()
	})

	it('returns null in production', async () => {
		process.env.NODE_ENV = 'production'
		const { db } = createTestContext()
		expect(await maybeBootstrapDev(db)).toBeNull()
	})

	it('returns null when explicitly disabled', async () => {
		process.env.NODE_ENV = 'development'
		process.env.MASKIN_AUTO_BOOTSTRAP = 'false'
		const { db } = createTestContext()
		expect(await maybeBootstrapDev(db)).toBeNull()
	})

	it('returns null when actors already exist', async () => {
		process.env.NODE_ENV = 'development'
		process.env.MASKIN_AUTO_BOOTSTRAP = 'true'
		const { db, mockResults } = createTestContext()
		mockResults.select = [{ count: 3 }]
		expect(await maybeBootstrapDev(db)).toBeNull()
	})

	it('creates actor + workspace + membership when DB is empty', async () => {
		process.env.NODE_ENV = 'development'
		process.env.MASKIN_AUTO_BOOTSTRAP = 'true'
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [[{ count: 0 }]]
		mockResults.insertQueue = [
			[{ id: 'actor-1', name: 'You', email: 'dev@local' }],
			[{ id: 'ws-1', name: 'My Workspace' }],
			[{ workspaceId: 'ws-1', actorId: 'actor-1', role: 'owner' }],
		]

		const result = await maybeBootstrapDev(db)
		expect(result).not.toBeNull()
		expect(result?.workspaceId).toBe('ws-1')
		expect(result?.actorEmail).toBe('dev@local')
		expect(result?.workspaceName).toBe('My Workspace')
		expect(result?.apiKey.startsWith('ank_')).toBe(true)
	})
})
