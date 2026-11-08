import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { installedLoops, marketplaceLoopItems, marketplaceLoops } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { seedMarketplaceLoops } from '../../lib/dev-bootstrap'
import { createApiError, formatZodError } from '../../lib/errors'
import { AgentStorageManager } from '../../services/agent-storage'
import { LoopVersionPusher } from '../../services/loop-version-pusher'
import { insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId, sql as rawSql } from './global-setup'

const { default: installedLoopsRoutes } = await import('../../routes/installed-loops')
const { default: marketplaceLoopsRoutes } = await import('../../routes/marketplace-loops')

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		agentStorage: AgentStorageManager
	}
}

function createMemoryStorage(): StorageProvider {
	const store = new Map<string, Buffer>()
	return {
		async put(key, data) {
			store.set(key, Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array))
		},
		async get(key) {
			const buf = store.get(key)
			if (!buf) throw new Error(`Not found: ${key}`)
			return buf
		},
		async list(prefix) {
			return [...store.keys()].filter((k) => k.startsWith(prefix))
		},
		async listWithMetadata(prefix) {
			return [...store.entries()]
				.filter(([k]) => k.startsWith(prefix))
				.map(([key, buf]) => ({ key, size: buf.length }))
		},
		async delete(key) {
			store.delete(key)
		},
		async exists(key) {
			return store.has(key)
		},
		async ensureBucket() {
			// no-op
		},
	}
}

function makeApp(actorId: string, agentStorage: AgentStorageManager) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('agentStorage', agentStorage)
		await next()
	})
	app.route('/api/installed-loops', installedLoopsRoutes)
	app.route('/api/marketplace', marketplaceLoopsRoutes)
	return app
}

// Marketplace loops that leave the seed list are retired (hidden, not deleted):
// installed_loops.source_loop_id has no ON DELETE rule, and the version pusher,
// installed list and uninstall all join on the marketplace row.
describe('Marketplace loop retirement', () => {
	const storage = createMemoryStorage()
	const agentStorage = new AgentStorageManager(storage, db)
	let app: ReturnType<typeof makeApp>

	beforeAll(() => {
		app = makeApp(getTestActorId(), agentStorage)
	})

	beforeEach(async () => {
		await rawSql`TRUNCATE marketplace_loops, marketplace_loop_items, installed_loops CASCADE`
		await seedMarketplaceLoops(db)
	})

	async function insertLegacyLoop(version = '1.0.0') {
		const [loop] = await db
			.insert(marketplaceLoops)
			.values({
				name: 'Legacy Loop',
				slug: `legacy-loop-${randomUUID()}`,
				description: 'No longer in the seed list',
				version,
				useCase: 'development',
			})
			.returning()
		if (!loop) throw new Error('marketplace_loops insert returned no row')
		return loop
	}

	async function installInFreshWorkspace(loopId: string) {
		const ws = await insertWorkspace(db, getTestActorId())
		if (!ws) throw new Error('workspace insert returned no row')
		const res = await app.request(
			jsonRequest('POST', '/api/installed-loops', { loopId, workspaceId: ws.id }),
		)
		return { ws, res }
	}

	it('retires a row whose slug is not in the seed list instead of deleting it', async () => {
		const legacy = await insertLegacyLoop()

		const result = await seedMarketplaceLoops(db)

		expect(result.retired).toEqual([legacy.slug])
		const [row] = await db.select().from(marketplaceLoops).where(eq(marketplaceLoops.id, legacy.id))
		expect(row?.retiredAt).toBeInstanceOf(Date)

		// Already retired: the next boot reports nothing new.
		const again = await seedMarketplaceLoops(db)
		expect(again.retired).toEqual([])
	})

	it('hides a retired loop from the marketplace list and its counts', async () => {
		const legacy = await insertLegacyLoop()
		await seedMarketplaceLoops(db)

		const res = await app.request(jsonGet('/api/marketplace/loops'))
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			loops: Array<{ slug: string }>
			counts: { total: number }
		}
		const slugs = body.loops.map((l) => l.slug)
		expect(slugs).not.toContain(legacy.slug)
		expect(slugs.sort()).toEqual(['market-competitor-watch-loop', 'product-discovery-loop'])
		expect(body.counts.total).toBe(2)
	})

	it('restores a retired slug that is back in the seed list', async () => {
		const [discovery] = await db
			.select()
			.from(marketplaceLoops)
			.where(eq(marketplaceLoops.slug, 'product-discovery-loop'))
		if (!discovery) throw new Error('expected product-discovery-loop to be seeded')
		await db
			.update(marketplaceLoops)
			.set({ retiredAt: new Date() })
			.where(eq(marketplaceLoops.id, discovery.id))

		// Version still matches the seed: restore must not take the "unchanged" shortcut.
		const result = await seedMarketplaceLoops(db)

		expect(result.updated).toEqual(['product-discovery-loop'])
		const [row] = await db
			.select()
			.from(marketplaceLoops)
			.where(eq(marketplaceLoops.id, discovery.id))
		expect(row?.retiredAt).toBeNull()
	})

	it('refuses a new install of a retired loop', async () => {
		const legacy = await insertLegacyLoop()
		await seedMarketplaceLoops(db)

		const { res } = await installInFreshWorkspace(legacy.id)

		expect(res.status).toBe(404)
	})

	it('refuses to install a single item by id once its loop is retired', async () => {
		const legacy = await insertLegacyLoop()
		const [item] = await db
			.insert(marketplaceLoopItems)
			.values({
				loopId: legacy.id,
				itemType: 'skill',
				sourceItemId: randomUUID(),
				itemSnapshot: { name: 'legacy-skill', content: '# Legacy skill' },
			})
			.returning()
		if (!item) throw new Error('marketplace_loop_items insert returned no row')
		const ws = await insertWorkspace(db, getTestActorId())
		if (!ws) throw new Error('workspace insert returned no row')

		// While the loop is listed, the item installs.
		const before = await app.request(
			jsonRequest('POST', `/api/marketplace/items/${item.id}/install`, { workspaceId: ws.id }),
		)
		expect(before.status).toBe(201)

		await seedMarketplaceLoops(db)

		// A fresh workspace, so a 409 "already installed" cannot mask the result.
		const otherWs = await insertWorkspace(db, getTestActorId())
		if (!otherWs) throw new Error('workspace insert returned no row')
		const after = await app.request(
			jsonRequest('POST', `/api/marketplace/items/${item.id}/install`, {
				workspaceId: otherWs.id,
			}),
		)
		expect(after.status).toBe(404)
	})

	it('keeps an existing install listed, updating and removable after its loop is retired', async () => {
		const legacy = await insertLegacyLoop('1.0.0')
		const { ws, res } = await installInFreshWorkspace(legacy.id)
		expect(res.status).toBe(201)
		const install = (await res.json()) as { id: string }

		// Bump the version the way a publisher would, then retire the loop.
		await db
			.update(marketplaceLoops)
			.set({ version: '1.1.0' })
			.where(eq(marketplaceLoops.id, legacy.id))
		const result = await seedMarketplaceLoops(db)
		expect(result.retired).toEqual([legacy.slug])

		// Installed list still joins on the retired row.
		const listRes = await app.request(jsonGet(`/api/installed-loops?workspaceId=${ws.id}`))
		expect(listRes.status).toBe(200)
		const list = (await listRes.json()) as {
			installs: Array<{ id: string; loopName: string; hasUpdate: boolean }>
		}
		expect(list.installs).toEqual([
			expect.objectContaining({ id: install.id, loopName: 'Legacy Loop', hasUpdate: true }),
		])

		// The version pusher still reaches the install.
		await new LoopVersionPusher(db, agentStorage).tick()
		const [pushed] = await db.select().from(installedLoops).where(eq(installedLoops.id, install.id))
		expect(pushed?.installedVersion).toBe('1.1.0')

		// Uninstall still works.
		const delRes = await app.request(
			jsonRequest('DELETE', `/api/installed-loops/${install.id}`, { keepProvisionedItems: false }),
		)
		expect(delRes.status).toBe(200)
		const remaining = await db
			.select()
			.from(installedLoops)
			.where(eq(installedLoops.id, install.id))
		expect(remaining).toEqual([])
	})
})
