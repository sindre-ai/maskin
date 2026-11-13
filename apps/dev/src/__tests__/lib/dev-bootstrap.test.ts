import { hashApiKey } from '@maskin/auth'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	maybeBootstrapDev,
	seedMarketplaceIfEmpty,
	seedMarketplaceLoops,
} from '../../lib/dev-bootstrap'
import {
	DISCOVERY_ACTOR_IDS,
	DISCOVERY_LOOP,
	DISCOVERY_TRIGGER_IDS,
} from '../../lib/marketplace-loops/discovery-loop'
import { MARKET_WATCH_LOOP } from '../../lib/marketplace-loops/market-watch-loop'
import { MEETING_MANAGER_LOOP } from '../../lib/marketplace-loops/meeting-manager-loop'
import { createTestContext } from '../setup'

const ALL_PACKAGES = [MARKET_WATCH_LOOP, DISCOVERY_LOOP, MEETING_MANAGER_LOOP]

function matchingMarketplaceRows() {
	return ALL_PACKAGES.map((loop, i) => ({
		id: `loop-${i}`,
		slug: loop.slug,
		version: loop.version,
	}))
}

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
		const { db, mockResults, calls } = createTestContext()
		// First select is findExistingCredentials, second is issueLoginKey's overflow check.
		mockResults.selectQueue = [
			[
				{
					actorId: 'actor-existing',
					actorName: 'Alice',
					actorEmail: 'alice@example.com',
					workspaceId: 'ws-existing',
					workspaceName: 'Team Space',
				},
			],
			[],
		]

		const result = await maybeBootstrapDev(db)
		expect(result).not.toBeNull()
		// Stored keys are hashed, so an existing one can't be read back: a fresh login key is minted.
		expect(result?.apiKey.startsWith('ank_')).toBe(true)
		expect(calls.inserts).toEqual([
			expect.objectContaining({
				actorId: 'actor-existing',
				kind: 'login',
				keyHash: hashApiKey(result?.apiKey ?? ''),
			}),
		])
		expect(result?.workspaceId).toBe('ws-existing')
		expect(result?.workspaceName).toBe('Team Space')
		expect(result?.created).toBe(false)
	})

	it('creates actor + workspace + membership + the full default agent roster when DB has no credentials', async () => {
		process.env.NODE_ENV = 'development'
		process.env.MASKIN_AUTO_BOOTSTRAP = 'true'
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [[]] // findExistingCredentials returns no rows
		// Unqueued selects fall through to [] — that's how seedDefaultAgentActors'
		// per-agent "already a member?" check reads as "not present" here, so each
		// of the six default agents takes the insert branch below.
		mockResults.insertQueue = [
			[{ id: 'actor-1', name: 'You', email: 'dev@local' }],
			[], // api_keys insert for the human's primary key
			[{ id: 'ws-1', name: 'My Workspace' }],
			[{ workspaceId: 'ws-1', actorId: 'actor-1', role: 'owner' }],
			// Default agents seed in DEFAULT_AGENT_IDS order, each an actor insert
			// followed by its workspace_members insert.
			[{ id: 'coach-1', name: 'Workspace Coach', isSystem: true }],
			[{ workspaceId: 'ws-1', actorId: 'coach-1', role: 'member' }],
			[{ id: 'chief-1', name: 'Chief of Staff', isSystem: true }],
			[{ workspaceId: 'ws-1', actorId: 'chief-1', role: 'member' }],
			[{ id: 'driver-1', name: 'Driver' }],
			[{ workspaceId: 'ws-1', actorId: 'driver-1', role: 'member' }],
			[{ id: 'signal-1', name: 'Signal Analyst' }],
			[{ workspaceId: 'ws-1', actorId: 'signal-1', role: 'member' }],
			[{ id: 'researcher-1', name: 'Researcher' }],
			[{ workspaceId: 'ws-1', actorId: 'researcher-1', role: 'member' }],
			[{ id: 'curator-1', name: 'Knowledge Curator' }],
			[{ workspaceId: 'ws-1', actorId: 'curator-1', role: 'member' }],
		]

		const result = await maybeBootstrapDev(db)
		expect(result).not.toBeNull()
		expect(result?.workspaceId).toBe('ws-1')
		expect(result?.actorEmail).toBe('dev@local')
		expect(result?.workspaceName).toBe('My Workspace')
		expect(result?.apiKey.startsWith('ank_')).toBe(true)
		expect(result?.created).toBe(true)

		// The human is inserted without a key; the key lives in api_keys as a hash only.
		const humanInsert = calls.inserts.find(
			(v): v is Record<string, unknown> =>
				typeof v === 'object' && v !== null && (v as { email?: string }).email === 'dev@local',
		)
		expect(humanInsert).toBeDefined()
		expect(humanInsert).not.toHaveProperty('apiKey')
		expect(calls.inserts).toContainEqual(
			expect.objectContaining({
				actorId: 'actor-1',
				kind: 'primary',
				keyHash: hashApiKey(result?.apiKey ?? ''),
			}),
		)

		// The dev bootstrap now goes through the same provisionWorkspace() path as
		// signup and POST /api/workspaces, so it seeds the whole roster rather than
		// just Workspace Coach + Chief of Staff.
		const insertedNames = calls.inserts
			.filter((v): v is { name?: string } => typeof v === 'object' && v !== null && 'name' in v)
			.map((v) => v.name)
		for (const name of [
			'Workspace Coach',
			'Chief of Staff',
			'Driver',
			'Signal Analyst',
			'Researcher',
			'Knowledge Curator',
		]) {
			expect(insertedNames).toContain(name)
		}

		const settingsUpdate = calls.updates.find(
			(u): u is { settings: { default_agent_id: string } } =>
				typeof u === 'object' &&
				u !== null &&
				'settings' in u &&
				typeof (u as { settings?: unknown }).settings === 'object',
		)
		expect(settingsUpdate?.settings.default_agent_id).toBe('chief-1')
	})

	it('throws naming the agent when the first default agent fails to seed, so the transaction rolls back', async () => {
		process.env.NODE_ENV = 'development'
		process.env.MASKIN_AUTO_BOOTSTRAP = 'true'
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [[]]
		mockResults.insertQueue = [
			[{ id: 'actor-1', name: 'You', email: 'dev@local' }],
			[], // api_keys insert for the human's primary key
			[{ id: 'ws-1', name: 'My Workspace' }],
			[{ workspaceId: 'ws-1', actorId: 'actor-1', role: 'owner' }],
			[], // Workspace Coach actor insert returns empty → should throw
		]

		await expect(maybeBootstrapDev(db)).rejects.toThrow(/workspace_coach/)
	})

	it('throws naming Chief of Staff when it is the agent that fails to seed', async () => {
		process.env.NODE_ENV = 'development'
		process.env.MASKIN_AUTO_BOOTSTRAP = 'true'
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [[]]
		mockResults.insertQueue = [
			[{ id: 'actor-1', name: 'You', email: 'dev@local' }],
			[], // api_keys insert for the human's primary key
			[{ id: 'ws-1', name: 'My Workspace' }],
			[{ workspaceId: 'ws-1', actorId: 'actor-1', role: 'owner' }],
			[{ id: 'coach-1', name: 'Workspace Coach', isSystem: true }],
			[{ workspaceId: 'ws-1', actorId: 'coach-1', role: 'member' }],
			[], // Chief of Staff actor insert returns empty → should throw
		]

		await expect(maybeBootstrapDev(db)).rejects.toThrow(/chief_of_staff/)
	})
})

describe('seedMarketplaceIfEmpty', () => {
	const originalEnv = { ...process.env }

	afterEach(() => {
		process.env = { ...originalEnv }
		vi.restoreAllMocks()
	})

	it('does nothing in production, even on an empty marketplace', async () => {
		process.env.NODE_ENV = 'production'
		const { db, mockResults, calls } = createTestContext()
		mockResults.select = []

		await seedMarketplaceIfEmpty(db)

		expect(calls.inserts).toEqual([])
	})

	it('does nothing when explicitly disabled', async () => {
		process.env.NODE_ENV = 'development'
		process.env.MASKIN_AUTO_BOOTSTRAP = 'false'
		const { db, mockResults, calls } = createTestContext()
		mockResults.select = []

		await seedMarketplaceIfEmpty(db)

		expect(calls.inserts).toEqual([])
	})

	it("no-ops when every loop's version already matches the marketplace", async () => {
		process.env.NODE_ENV = 'development'
		process.env.MASKIN_AUTO_BOOTSTRAP = 'true'
		const { db, mockResults, calls } = createTestContext()
		mockResults.select = matchingMarketplaceRows()

		await seedMarketplaceIfEmpty(db)

		expect(calls.inserts).toEqual([])
		expect(calls.updates).toEqual([])
	})

	it('inserts every loop when the marketplace is empty', async () => {
		process.env.NODE_ENV = 'development'
		process.env.MASKIN_AUTO_BOOTSTRAP = 'true'
		const { db, mockResults, calls } = createTestContext()
		mockResults.select = []
		mockResults.insert = [{ id: 'loop-1' }]

		await seedMarketplaceIfEmpty(db)

		// Every loop does one marketplace_loops insert (values() called with a
		// single object carrying `slug`) and one marketplace_loop_items insert
		// (values() called with an array), in that order.
		const packageInserts = calls.inserts.filter(
			(v): v is { slug: string } =>
				typeof v === 'object' && v !== null && !Array.isArray(v) && 'slug' in v,
		)
		const itemInserts = calls.inserts.filter((v): v is unknown[] => Array.isArray(v))

		expect(packageInserts.length).toBe(ALL_PACKAGES.length)
		expect(itemInserts.length).toBe(ALL_PACKAGES.length)

		const slugs = packageInserts.map((p) => p.slug)
		expect(new Set(slugs).size).toBe(ALL_PACKAGES.length)
		expect(slugs).toEqual(expect.arrayContaining(ALL_PACKAGES.map((p) => p.slug)))

		// Market Watch is seeded first, Product Discovery second, Meeting Manager third — assert the
		// discovery actor/trigger counts match its bundle.
		const discoveryItems = itemInserts[1] as Array<{ itemType: string; sourceItemId: string }>
		expect(discoveryItems.filter((i) => i.itemType === 'actor').length).toBe(
			DISCOVERY_ACTOR_IDS.length,
		)
		expect(discoveryItems.filter((i) => i.itemType === 'trigger').length).toBe(
			DISCOVERY_TRIGGER_IDS.length,
		)
	})
})

describe('seedMarketplaceLoops', () => {
	const originalEnv = { ...process.env }

	afterEach(() => {
		process.env = { ...originalEnv }
		vi.restoreAllMocks()
	})

	it('inserts every loop even when NODE_ENV is production — scripts/seed-marketplace.ts (the deploy-time entrypoint) calls this directly, unguarded', async () => {
		process.env.NODE_ENV = 'production'
		const { db, mockResults, calls } = createTestContext()
		mockResults.select = []
		mockResults.insert = [{ id: 'loop-1' }]

		const result = await seedMarketplaceLoops(db)

		expect(result.inserted.length).toBe(ALL_PACKAGES.length)
		expect(result.updated).toEqual([])
		expect(result.unchanged).toEqual([])
		expect(calls.inserts.length).toBeGreaterThan(0)
	})

	it("no-ops when every loop's version already matches, regardless of NODE_ENV", async () => {
		process.env.NODE_ENV = 'production'
		const { db, mockResults, calls } = createTestContext()
		mockResults.select = matchingMarketplaceRows()

		const result = await seedMarketplaceLoops(db)

		expect(result.inserted).toEqual([])
		expect(result.updated).toEqual([])
		expect(result.unchanged.length).toBe(ALL_PACKAGES.length)
		expect(calls.inserts).toEqual([])
	})

	it('retires a marketplace row whose slug is no longer in the seed list', async () => {
		process.env.NODE_ENV = 'production'
		const { db, mockResults, calls } = createTestContext()
		mockResults.select = [
			...matchingMarketplaceRows(),
			{ id: 'loop-old', slug: 'old-loop', version: '1.0.0', retiredAt: null },
		]

		const result = await seedMarketplaceLoops(db)

		expect(result.retired).toEqual(['old-loop'])
		expect(result.unchanged.length).toBe(ALL_PACKAGES.length)
		expect(calls.updates).toEqual([expect.objectContaining({ retiredAt: expect.any(Date) })])
		expect(calls.inserts).toEqual([])
	})

	it('leaves an already retired row alone', async () => {
		process.env.NODE_ENV = 'production'
		const { db, mockResults, calls } = createTestContext()
		mockResults.select = [
			...matchingMarketplaceRows(),
			{ id: 'loop-old', slug: 'old-loop', version: '1.0.0', retiredAt: new Date() },
		]

		const result = await seedMarketplaceLoops(db)

		expect(result.retired).toEqual([])
		expect(calls.updates).toEqual([])
	})

	it('restores a retired loop that is back in the seed list, even at the same version', async () => {
		process.env.NODE_ENV = 'production'
		const { db, mockResults, calls } = createTestContext()
		mockResults.select = matchingMarketplaceRows().map((row) =>
			row.slug === DISCOVERY_LOOP.slug ? { ...row, retiredAt: new Date() } : row,
		)
		mockResults.insert = [{ id: 'loop-1' }]

		const result = await seedMarketplaceLoops(db)

		expect(result.updated).toEqual([DISCOVERY_LOOP.slug])
		expect(result.retired).toEqual([])
		expect(calls.updates).toEqual([expect.objectContaining({ retiredAt: null })])
	})

	it('updates a loop and replaces its items when its version has changed', async () => {
		process.env.NODE_ENV = 'production'
		const { db, mockResults, calls } = createTestContext()
		mockResults.select = matchingMarketplaceRows().map((row) =>
			row.slug === DISCOVERY_LOOP.slug ? { ...row, version: 'stale-version' } : row,
		)
		mockResults.insert = [{ id: 'loop-1' }]

		const result = await seedMarketplaceLoops(db)

		expect(result.updated).toEqual([DISCOVERY_LOOP.slug])
		expect(result.inserted).toEqual([])
		expect(result.unchanged.length).toBe(ALL_PACKAGES.length - 1)
		expect(calls.updates.length).toBe(1)

		const itemInserts = calls.inserts.filter((v): v is unknown[] => Array.isArray(v))
		expect(itemInserts.length).toBe(1)
		const discoveryItems = itemInserts[0] as Array<{ itemType: string }>
		expect(discoveryItems.filter((i) => i.itemType === 'actor').length).toBe(
			DISCOVERY_ACTOR_IDS.length,
		)
	})
})
