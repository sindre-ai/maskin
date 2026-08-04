import { afterEach, describe, expect, it, vi } from 'vitest'
import { maybeBootstrapDev, seedCatalogIfEmpty } from '../../lib/dev-bootstrap'
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

	it('creates actor + workspace + membership + Workspace Coach + Chief of Staff when DB has no credentials', async () => {
		process.env.NODE_ENV = 'development'
		process.env.MASKIN_AUTO_BOOTSTRAP = 'true'
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [[]] // findExistingCredentials returns no rows
		mockResults.insertQueue = [
			[{ id: 'actor-1', name: 'You', email: 'dev@local' }],
			[{ id: 'ws-1', name: 'My Workspace' }],
			[{ workspaceId: 'ws-1', actorId: 'actor-1', role: 'owner' }],
			[{ id: 'coach-1', name: 'Workspace Coach', isSystem: true }],
			[{ workspaceId: 'ws-1', actorId: 'coach-1', role: 'member' }],
			[{ id: 'chief-1', name: 'Chief of Staff', isSystem: true }],
			[{ workspaceId: 'ws-1', actorId: 'chief-1', role: 'member' }],
		]

		const result = await maybeBootstrapDev(db)
		expect(result).not.toBeNull()
		expect(result?.workspaceId).toBe('ws-1')
		expect(result?.actorEmail).toBe('dev@local')
		expect(result?.workspaceName).toBe('My Workspace')
		expect(result?.apiKey.startsWith('ank_')).toBe(true)
		expect(result?.created).toBe(true)

		const insertedNames = calls.inserts
			.filter((v): v is { name?: string } => typeof v === 'object' && v !== null && 'name' in v)
			.map((v) => v.name)
		expect(insertedNames).toContain('Workspace Coach')
		expect(insertedNames).toContain('Chief of Staff')

		const settingsUpdate = calls.updates.find(
			(u): u is { settings: { default_agent_id: string } } =>
				typeof u === 'object' &&
				u !== null &&
				'settings' in u &&
				typeof (u as { settings?: unknown }).settings === 'object',
		)
		expect(settingsUpdate?.settings.default_agent_id).toBe('chief-1')
	})

	it('throws if Workspace Coach seeding fails so the transaction rolls back', async () => {
		process.env.NODE_ENV = 'development'
		process.env.MASKIN_AUTO_BOOTSTRAP = 'true'
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [[]]
		mockResults.insertQueue = [
			[{ id: 'actor-1', name: 'You', email: 'dev@local' }],
			[{ id: 'ws-1', name: 'My Workspace' }],
			[{ workspaceId: 'ws-1', actorId: 'actor-1', role: 'owner' }],
			[], // Workspace Coach actor insert returns empty → should throw
		]

		await expect(maybeBootstrapDev(db)).rejects.toThrow(/Workspace Coach/)
	})

	it('throws if Chief of Staff seeding fails so the transaction rolls back', async () => {
		process.env.NODE_ENV = 'development'
		process.env.MASKIN_AUTO_BOOTSTRAP = 'true'
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [[]]
		mockResults.insertQueue = [
			[{ id: 'actor-1', name: 'You', email: 'dev@local' }],
			[{ id: 'ws-1', name: 'My Workspace' }],
			[{ workspaceId: 'ws-1', actorId: 'actor-1', role: 'owner' }],
			[{ id: 'coach-1', name: 'Workspace Coach', isSystem: true }],
			[{ workspaceId: 'ws-1', actorId: 'coach-1', role: 'member' }],
			[], // Chief of Staff actor insert returns empty → should throw
		]

		await expect(maybeBootstrapDev(db)).rejects.toThrow(/Chief of Staff/)
	})
})

describe('seedCatalogIfEmpty', () => {
	const originalEnv = { ...process.env }

	afterEach(() => {
		process.env = { ...originalEnv }
		vi.restoreAllMocks()
	})

	it('does nothing in production, even on an empty catalog', async () => {
		process.env.NODE_ENV = 'production'
		const { db, mockResults, calls } = createTestContext()
		mockResults.select = [{ n: 0 }]

		await seedCatalogIfEmpty(db)

		expect(calls.inserts).toEqual([])
	})

	it('does nothing when explicitly disabled', async () => {
		process.env.NODE_ENV = 'development'
		process.env.MASKIN_AUTO_BOOTSTRAP = 'false'
		const { db, mockResults, calls } = createTestContext()
		mockResults.select = [{ n: 0 }]

		await seedCatalogIfEmpty(db)

		expect(calls.inserts).toEqual([])
	})

	it('no-ops when the catalog already has packages', async () => {
		process.env.NODE_ENV = 'development'
		process.env.MASKIN_AUTO_BOOTSTRAP = 'true'
		const { db, mockResults, calls } = createTestContext()
		mockResults.select = [{ n: 3 }]

		await seedCatalogIfEmpty(db)

		expect(calls.inserts).toEqual([])
	})

	it('seeds the CCD package when the catalog is empty outside production', async () => {
		process.env.NODE_ENV = 'development'
		process.env.MASKIN_AUTO_BOOTSTRAP = 'true'
		const { db, mockResults, calls } = createTestContext()
		mockResults.select = [{ n: 0 }]
		mockResults.insertQueue = [[{ id: 'pkg-1' }], []]

		await seedCatalogIfEmpty(db)

		expect(calls.inserts.length).toBeGreaterThan(0)
	})
})
