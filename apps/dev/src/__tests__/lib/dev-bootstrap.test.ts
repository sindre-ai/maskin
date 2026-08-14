import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	maybeBootstrapDev,
	seedMarketplaceIfEmpty,
	seedMarketplaceLoops,
} from '../../lib/dev-bootstrap'
import { CCD_ACTOR_IDS, CCD_LOOP, CCD_TRIGGER_IDS } from '../../lib/marketplace-loops/ccd-loop'
import { DEV_PIPELINE_LOOP } from '../../lib/marketplace-loops/dev-pipeline-loop'
import { GROWTH_BET_LOOP } from '../../lib/marketplace-loops/growth-bet-loop'
import { GROWTH_BRAND_DEMAND_LOOP } from '../../lib/marketplace-loops/growth-brand-demand-loop'
import { GROWTH_CONTENT_INSIGHT_LOOP } from '../../lib/marketplace-loops/growth-content-insight-loop'
import { GROWTH_DEAL_RELATIONSHIP_LOOP } from '../../lib/marketplace-loops/growth-deal-relationship-loop'
import { GROWTH_LEAD_GEN_LOOP } from '../../lib/marketplace-loops/growth-lead-gen-loop'
import { GROWTH_MEETING_LOOP } from '../../lib/marketplace-loops/growth-meeting-loop'
import { GROWTH_OPS_KNOWLEDGE_LOOP } from '../../lib/marketplace-loops/growth-ops-knowledge-loop'
import { GROWTH_SDR_OUTREACH_LOOP } from '../../lib/marketplace-loops/growth-sdr-outreach-loop'
import { STRATEGY_GROWTH_LOOP } from '../../lib/marketplace-loops/strategy-growth-loop'
import { TEAM_OPS_LOOP } from '../../lib/marketplace-loops/team-ops-loop'
import { createTestContext } from '../setup'

const ALL_PACKAGES = [
	CCD_LOOP,
	DEV_PIPELINE_LOOP,
	STRATEGY_GROWTH_LOOP,
	TEAM_OPS_LOOP,
	GROWTH_LEAD_GEN_LOOP,
	GROWTH_SDR_OUTREACH_LOOP,
	GROWTH_DEAL_RELATIONSHIP_LOOP,
	GROWTH_CONTENT_INSIGHT_LOOP,
	GROWTH_BRAND_DEMAND_LOOP,
	GROWTH_BET_LOOP,
	GROWTH_OPS_KNOWLEDGE_LOOP,
	GROWTH_MEETING_LOOP,
]

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

	it('inserts all 12 loops when the marketplace is empty', async () => {
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

		expect(packageInserts.length).toBe(12)
		expect(itemInserts.length).toBe(12)

		const slugs = packageInserts.map((p) => p.slug)
		expect(new Set(slugs).size).toBe(12)
		expect(slugs).toEqual(expect.arrayContaining(ALL_PACKAGES.map((p) => p.slug)))

		// CCD is seeded first — assert its actor/trigger counts match the live bundle.
		const ccdItems = itemInserts[0] as Array<{ itemType: string; sourceItemId: string }>
		expect(ccdItems.filter((i) => i.itemType === 'actor').length).toBe(CCD_ACTOR_IDS.length)
		expect(ccdItems.filter((i) => i.itemType === 'trigger').length).toBe(CCD_TRIGGER_IDS.length)
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

		expect(result.inserted.length).toBe(12)
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
		expect(result.unchanged.length).toBe(12)
		expect(calls.inserts).toEqual([])
	})

	it('updates a loop and replaces its items when its version has changed', async () => {
		process.env.NODE_ENV = 'production'
		const { db, mockResults, calls } = createTestContext()
		mockResults.select = matchingMarketplaceRows().map((row) =>
			row.slug === CCD_LOOP.slug ? { ...row, version: 'stale-version' } : row,
		)
		mockResults.insert = [{ id: 'loop-1' }]

		const result = await seedMarketplaceLoops(db)

		expect(result.updated).toEqual([CCD_LOOP.slug])
		expect(result.inserted).toEqual([])
		expect(result.unchanged.length).toBe(11)
		expect(calls.updates.length).toBe(1)

		const itemInserts = calls.inserts.filter((v): v is unknown[] => Array.isArray(v))
		expect(itemInserts.length).toBe(1)
		const ccdItems = itemInserts[0] as Array<{ itemType: string }>
		expect(ccdItems.filter((i) => i.itemType === 'actor').length).toBe(CCD_ACTOR_IDS.length)
	})
})
