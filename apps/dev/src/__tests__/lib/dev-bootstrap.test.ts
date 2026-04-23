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

	it('returns existing credentials when actor + workspace already exist', async () => {
		process.env.NODE_ENV = 'development'
		process.env.MASKIN_AUTO_BOOTSTRAP = 'true'
		const { db, mockResults } = createTestContext()
		mockResults.select = [
			{
				apiKey: 'ank_existingkey',
				actorName: 'Alice',
				actorEmail: 'alice@example.com',
				workspaceId: 'ws-existing',
				workspaceName: 'Team Space',
			},
		]

		const result = await maybeBootstrapDev(db)
		expect(result).not.toBeNull()
		expect(result?.apiKey).toBe('ank_existingkey')
		expect(result?.workspaceId).toBe('ws-existing')
		expect(result?.workspaceName).toBe('Team Space')
		expect(result?.created).toBe(false)
	})

	it('creates actor + workspace + membership + Sindre when DB has no credentials', async () => {
		process.env.NODE_ENV = 'development'
		process.env.MASKIN_AUTO_BOOTSTRAP = 'true'
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [[]] // findExistingCredentials returns no rows
		mockResults.insertQueue = [
			[{ id: 'actor-1', name: 'You', email: 'dev@local' }],
			[{ id: 'ws-1', name: 'My Workspace' }],
			[{ workspaceId: 'ws-1', actorId: 'actor-1', role: 'owner' }],
			[{ id: 'sindre-1', name: 'Sindre', isSystem: true }],
			[{ workspaceId: 'ws-1', actorId: 'sindre-1', role: 'member' }],
		]

		const result = await maybeBootstrapDev(db)
		expect(result).not.toBeNull()
		expect(result?.workspaceId).toBe('ws-1')
		expect(result?.actorEmail).toBe('dev@local')
		expect(result?.workspaceName).toBe('My Workspace')
		expect(result?.apiKey.startsWith('ank_')).toBe(true)
		expect(result?.created).toBe(true)
	})

	it('throws if Sindre seeding fails so the transaction rolls back', async () => {
		process.env.NODE_ENV = 'development'
		process.env.MASKIN_AUTO_BOOTSTRAP = 'true'
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [[]]
		mockResults.insertQueue = [
			[{ id: 'actor-1', name: 'You', email: 'dev@local' }],
			[{ id: 'ws-1', name: 'My Workspace' }],
			[{ workspaceId: 'ws-1', actorId: 'actor-1', role: 'owner' }],
			[], // Sindre actor insert returns empty → should throw
		]

		await expect(maybeBootstrapDev(db)).rejects.toThrow(/Sindre/)
	})
})
