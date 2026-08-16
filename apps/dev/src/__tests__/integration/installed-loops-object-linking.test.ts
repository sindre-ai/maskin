import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { marketplaceLoopItems, marketplaceLoops, objects } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { AgentStorageManager } from '../../services/agent-storage'
import { insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId, sql as rawSql } from './global-setup'

// Loaded lazily so vitest doesn't pull the routes in at module resolution
// time (mirrors the pattern used in loops.test.ts / installed-loops-skills.test.ts).
const { default: installedLoopsRoutes } = await import('../../routes/installed-loops')
const { default: loopsRoutes } = await import('../../routes/loops')

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

function makeApp(actorId: string) {
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
	const agentStorage = new AgentStorageManager(createMemoryStorage(), db)
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('agentStorage', agentStorage)
		await next()
	})
	app.route('/api/installed-loops', installedLoopsRoutes)
	app.route('/api/loops', loopsRoutes)
	return app
}

/**
 * Seed a marketplace loop with one actor item and one trigger targeting it —
 * enough to exercise `metadata.trigger_ids` seeding and `GET /api/loops`'s
 * trigger→agent derivation on install.
 */
async function seedMarketplaceLoop(overrides?: { version?: string }) {
	const [loop] = await db
		.insert(marketplaceLoops)
		.values({
			name: 'Outreach Loop',
			slug: `outreach-loop-${randomUUID()}`,
			description: 'Send outreach and follow up',
			version: overrides?.version ?? '1.0.0',
			useCase: 'growth',
		})
		.returning()
	if (!loop) throw new Error('marketplace_loops insert returned no row')

	const sourceActorId = randomUUID()
	const sourceTriggerId = randomUUID()

	await db.insert(marketplaceLoopItems).values([
		{
			loopId: loop.id,
			itemType: 'actor',
			sourceItemId: sourceActorId,
			itemSnapshot: {
				type: 'agent',
				name: 'Outreach Bot',
				description: 'Sends outreach',
				systemPrompt: 'You send outreach.',
				llmProvider: 'anthropic',
				llmConfig: {},
				tools: {},
			},
		},
		{
			loopId: loop.id,
			itemType: 'trigger',
			sourceItemId: sourceTriggerId,
			itemSnapshot: {
				name: 'Daily outreach',
				type: 'cron',
				config: { schedule: '0 9 * * *' },
				actionPrompt: 'Send today’s outreach batch.',
				targetActorId: sourceActorId,
				enabled: true,
			},
		},
	])

	return { loop, sourceActorId, sourceTriggerId }
}

async function install(app: ReturnType<typeof makeApp>, loopId: string, workspaceId: string) {
	return app.request(jsonRequest('POST', '/api/installed-loops', { loopId, workspaceId }))
}

describe('Installed Loops → Loop object linking', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		// The global beforeEach clears workspace-scoped tables but not the global
		// marketplace tables — clear them here so loops don't accumulate across tests.
		await rawSql`TRUNCATE marketplace_loops, marketplace_loop_items CASCADE`
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		if (!ws) throw new Error('workspace insert returned no row')
		workspaceId = ws.id
	})

	it('creates an objects row (type=loop) linked back via installedLoops.objectId, seeded with trigger_ids and lineage', async () => {
		const { loop, sourceTriggerId } = await seedMarketplaceLoop()
		const app = makeApp(actorId)

		const res = await install(app, loop.id, workspaceId)
		expect(res.status).toBe(201)
		const installed = await res.json()
		expect(installed.objectId).toBeTruthy()

		const [loopObject] = await db.select().from(objects).where(eq(objects.id, installed.objectId))
		if (!loopObject) throw new Error('linked loop object not found')
		expect(loopObject.type).toBe('loop')
		expect(loopObject.status).toBe('running')
		expect(loopObject.title).toBe(loop.name)
		expect(loopObject.workspaceId).toBe(workspaceId)

		const meta = loopObject.metadata as Record<string, unknown>
		expect(meta.installed_from_marketplace_loop_id).toBe(loop.id)
		expect(Array.isArray(meta.trigger_ids)).toBe(true)
		expect(meta.trigger_ids as string[]).toHaveLength(1)

		// The trigger_ids entry is the LOCAL provisioned trigger id, not the
		// publisher's source_item_id.
		expect((meta.trigger_ids as string[])[0]).not.toBe(sourceTriggerId)
	})

	it('GET /api/loops surfaces the install-created loop with agentIds derived from its triggers', async () => {
		const { loop } = await seedMarketplaceLoop()
		const app = makeApp(actorId)

		const installRes = await install(app, loop.id, workspaceId)
		const installed = await installRes.json()

		const listRes = await app.request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		expect(listRes.status).toBe(200)
		const body = (await listRes.json()) as {
			loops: Array<{ id: string; agentIds: string[]; triggerIds: string[]; status: string }>
		}
		expect(body.loops).toHaveLength(1)
		const row = body.loops[0]
		if (!row) throw new Error('loop row not found in GET /api/loops response')
		expect(row.id).toBe(installed.objectId)
		expect(row.status).toBe('running')
		expect(row.triggerIds).toHaveLength(1)
		// Exactly one agent (the provisioned actor) reachable through the
		// installed trigger's targetActorId.
		expect(row.agentIds).toHaveLength(1)
	})

	it('uninstall with keepProvisionedItems=false deletes the linked loop object', async () => {
		const { loop } = await seedMarketplaceLoop()
		const app = makeApp(actorId)

		const installRes = await install(app, loop.id, workspaceId)
		const installed = await installRes.json()
		expect(installed.objectId).toBeTruthy()

		const res = await app.request(
			jsonRequest('DELETE', `/api/installed-loops/${installed.id}`, {
				keepProvisionedItems: false,
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.removedLoopObject).toBe(true)

		const remaining = await db.select().from(objects).where(eq(objects.id, installed.objectId))
		expect(remaining).toHaveLength(0)
	})

	it('uninstall with keepProvisionedItems=true keeps the linked loop object untouched', async () => {
		const { loop } = await seedMarketplaceLoop()
		const app = makeApp(actorId)

		const installRes = await install(app, loop.id, workspaceId)
		const installed = await installRes.json()

		const res = await app.request(
			jsonRequest('DELETE', `/api/installed-loops/${installed.id}`, {
				keepProvisionedItems: true,
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.removedLoopObject).toBe(false)

		const [remaining] = await db.select().from(objects).where(eq(objects.id, installed.objectId))
		if (!remaining) throw new Error('loop object should survive a keep-items uninstall')
		expect(remaining.status).toBe('running')
		const meta = remaining.metadata as Record<string, unknown>
		expect(meta.installed_from_marketplace_loop_id).toBe(loop.id)
	})

	it('fork leaves the linked loop object and its trigger_ids untouched', async () => {
		const { loop } = await seedMarketplaceLoop()
		const app = makeApp(actorId)

		const installRes = await install(app, loop.id, workspaceId)
		const installed = await installRes.json()

		const [before] = await db.select().from(objects).where(eq(objects.id, installed.objectId))
		if (!before) throw new Error('linked loop object not found before fork')

		const forkRes = await app.request(
			jsonRequest('POST', `/api/installed-loops/${installed.id}/fork`),
		)
		expect(forkRes.status).toBe(200)
		const forkBody = await forkRes.json()
		expect(forkBody.objectId).toBe(installed.objectId)

		const [after] = await db.select().from(objects).where(eq(objects.id, installed.objectId))
		if (!after) throw new Error('linked loop object not found after fork')
		expect(after.status).toBe(before.status)
		expect(after.metadata).toEqual(before.metadata)
	})
})
