import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { actors, marketplaceLoopItems, marketplaceLoops, workspaceMembers } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { AgentStorageManager } from '../../services/agent-storage'
import { LoopVersionPusher } from '../../services/loop-version-pusher'
import { insertActor, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId, sql as rawSql } from './global-setup'

const { default: installedLoopsRoutes } = await import('../../routes/installed-loops')
const { default: marketplaceLoopsRoutes } = await import('../../routes/marketplace-loops')

type Env = {
	Variables: {
		db: Database
		actorId: string
		agentStorage: AgentStorageManager
	}
}

function createMemoryStorage(): StorageProvider & { _store: Map<string, Buffer> } {
	const store = new Map<string, Buffer>()
	return {
		_store: store,
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
		async ensureBucket() {},
	}
}

function createApp(storage: StorageProvider) {
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
	const agentStorage = new AgentStorageManager(storage, db)
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', getTestActorId())
		c.set('agentStorage', agentStorage)
		await next()
	})
	app.route('/api/installed-loops', installedLoopsRoutes)
	app.route('/api/marketplace', marketplaceLoopsRoutes as never)
	return app
}

async function seedLoopWithTwoAgents() {
	const [loop] = await db
		.insert(marketplaceLoops)
		.values({
			name: 'Two Agent Loop',
			slug: `two-agent-loop-${randomUUID()}`,
			description: 'Two agents',
			version: '1.0.0',
			useCase: 'development',
		})
		.returning()
	if (!loop) throw new Error('marketplace_loops insert returned no row')

	const items = []
	for (const name of ['Alpha Bot', 'Beta Bot']) {
		const [item] = await db
			.insert(marketplaceLoopItems)
			.values({
				loopId: loop.id,
				itemType: 'actor',
				sourceItemId: randomUUID(),
				itemSnapshot: {
					type: 'agent',
					name,
					description: name,
					systemPrompt: 'You help.',
					llmProvider: 'anthropic',
					llmConfig: {},
					tools: {},
				},
			})
			.returning()
		if (!item) throw new Error('marketplace_loop_items insert returned no row')
		items.push(item)
	}
	const [alphaItem, betaItem] = items
	if (!alphaItem || !betaItem) throw new Error('expected two marketplace items')
	return { loop, alphaItem, betaItem }
}

function memoryKeys(workspaceId: string, actorId: string) {
	return [
		`agents/${workspaceId}/${actorId}/memory/CLAUDE.md`,
		`agents/${workspaceId}/${actorId}/learnings/session-1.md`,
	]
}

describe('Removing an agent through a loop path deletes its S3 folder', () => {
	let workspaceId: string
	let storage: ReturnType<typeof createMemoryStorage>

	beforeEach(async () => {
		await rawSql`TRUNCATE marketplace_loops, marketplace_loop_items CASCADE`
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		storage = createMemoryStorage()
	})

	async function installLoop(app: ReturnType<typeof createApp>, loopId: string) {
		const res = await app.request(
			jsonRequest('POST', '/api/installed-loops', { loopId, workspaceId }),
		)
		expect(res.status).toBe(201)
		return (await res.json()) as { id: string }
	}

	async function providedActorId(name: string) {
		const [row] = await db
			.select({ id: actors.id })
			.from(actors)
			.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
			.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.name, name)))
		if (!row) throw new Error(`provisioned actor ${name} not found`)
		return row.id
	}

	async function putMemory(actorId: string, forWorkspaceId = workspaceId) {
		for (const key of memoryKeys(forWorkspaceId, actorId)) {
			await storage.put(key, Buffer.from('fake memory'))
		}
	}

	// Keys that must survive: the other agent in the same workspace, the same id
	// in another workspace, and an id that merely starts with the removed one.
	async function putSurvivors(removedActorId: string, otherActorId: string) {
		const keys = [
			...memoryKeys(workspaceId, otherActorId),
			`agents/${randomUUID()}/${removedActorId}/memory/CLAUDE.md`,
			`agents/${workspaceId}/${removedActorId}-extra/memory/CLAUDE.md`,
		]
		for (const key of keys) await storage.put(key, Buffer.from('fake memory'))
		return keys
	}

	describe('installed-loops uninstall', () => {
		it('deletes the removed agents folder and leaves other agents untouched', async () => {
			const { loop } = await seedLoopWithTwoAgents()
			const app = createApp(storage)
			const installed = await installLoop(app, loop.id)
			const alphaId = await providedActorId('Alpha Bot')
			const betaId = await providedActorId('Beta Bot')
			const bystander = await insertActor(db, { type: 'agent', name: 'Bystander' })
			await putMemory(alphaId)
			await putMemory(betaId)
			await putMemory(bystander.id)
			const survivors = [
				...memoryKeys(workspaceId, bystander.id),
				...(await putSurvivors(alphaId, bystander.id)),
			]

			const res = await app.request(
				jsonRequest('DELETE', `/api/installed-loops/${installed.id}`, {
					keepProvisionedItems: false,
				}),
			)
			expect(res.status).toBe(200)

			expect(await storage.list(`agents/${workspaceId}/${alphaId}/`)).toEqual([])
			expect(await storage.list(`agents/${workspaceId}/${betaId}/`)).toEqual([])
			for (const key of survivors) expect(await storage.exists(key)).toBe(true)
		})

		it('still completes the uninstall when a storage delete fails', async () => {
			const { loop } = await seedLoopWithTwoAgents()
			const app = createApp(storage)
			const installed = await installLoop(app, loop.id)
			const alphaId = await providedActorId('Alpha Bot')
			const betaId = await providedActorId('Beta Bot')
			await putMemory(alphaId)
			await putMemory(betaId)
			const failingKey = memoryKeys(workspaceId, alphaId)[0] as string
			const realDelete = storage.delete.bind(storage)
			storage.delete = async (key: string) => {
				if (key === failingKey) throw new Error('s3 unavailable')
				await realDelete(key)
			}

			const res = await app.request(
				jsonRequest('DELETE', `/api/installed-loops/${installed.id}`, {
					keepProvisionedItems: false,
				}),
			)
			expect(res.status).toBe(200)

			// The agents are gone, the failure is logged, and the other agent's
			// folder is still cleaned up.
			expect(await db.select().from(actors).where(eq(actors.id, alphaId))).toHaveLength(0)
			expect(await storage.list(`agents/${workspaceId}/${betaId}/`)).toEqual([])
			expect(await storage.exists(failingKey)).toBe(true)
		})
	})

	describe('loop version pusher', () => {
		it('deletes the folder of an agent a new loop version drops and leaves others untouched', async () => {
			const { loop, betaItem } = await seedLoopWithTwoAgents()
			const app = createApp(storage)
			await installLoop(app, loop.id)
			const alphaId = await providedActorId('Alpha Bot')
			const betaId = await providedActorId('Beta Bot')
			await putMemory(alphaId)
			await putMemory(betaId)
			const survivors = [
				...memoryKeys(workspaceId, alphaId),
				...(await putSurvivors(betaId, alphaId)),
			]

			// The publisher ships 1.1.0 without the Beta agent.
			await db.delete(marketplaceLoopItems).where(eq(marketplaceLoopItems.id, betaItem.id))
			await db
				.update(marketplaceLoops)
				.set({ version: '1.1.0' })
				.where(eq(marketplaceLoops.id, loop.id))

			await new LoopVersionPusher(db, new AgentStorageManager(storage, db)).tick()

			expect(await db.select().from(actors).where(eq(actors.id, betaId))).toHaveLength(0)
			expect(await storage.list(`agents/${workspaceId}/${betaId}/`)).toEqual([])
			for (const key of survivors) expect(await storage.exists(key)).toBe(true)
		})
	})

	describe('marketplace item uninstall', () => {
		async function installSingleAgent() {
			const { loop, alphaItem } = await seedLoopWithTwoAgents()
			const agent = await insertActor(db, {
				type: 'agent',
				name: 'Marketplace Agent',
				metadata: { marketplace_item_id: alphaItem.id },
			})
			await db.insert(workspaceMembers).values({ workspaceId, actorId: agent.id, role: 'member' })
			return { loop, item: alphaItem, agentId: agent.id }
		}

		it('deletes the agents folder and leaves other agents untouched', async () => {
			const { item, agentId } = await installSingleAgent()
			const bystander = await insertActor(db, { type: 'agent', name: 'Bystander' })
			await putMemory(agentId)
			const survivors = [
				...memoryKeys(workspaceId, bystander.id),
				...(await putSurvivors(agentId, bystander.id)),
			]

			const res = await createApp(storage).request(
				jsonRequest('DELETE', `/api/marketplace/items/${item.id}/uninstall`, {
					workspaceId,
					keepProvisionedItems: false,
				}),
			)
			expect(res.status).toBe(200)

			expect(await db.select().from(actors).where(eq(actors.id, agentId))).toHaveLength(0)
			expect(await storage.list(`agents/${workspaceId}/${agentId}/`)).toEqual([])
			for (const key of survivors) expect(await storage.exists(key)).toBe(true)
		})

		it('returns 500 and keeps the agent when a storage delete fails', async () => {
			const { item, agentId } = await installSingleAgent()
			await putMemory(agentId)
			const failingKey = memoryKeys(workspaceId, agentId)[0] as string
			const realDelete = storage.delete.bind(storage)
			storage.delete = async (key: string) => {
				if (key === failingKey) throw new Error('s3 unavailable')
				await realDelete(key)
			}

			const res = await createApp(storage).request(
				jsonRequest('DELETE', `/api/marketplace/items/${item.id}/uninstall`, {
					workspaceId,
					keepProvisionedItems: false,
				}),
			)
			expect(res.status).toBe(500)

			// The agent is still there so the uninstall can be retried.
			expect(await db.select().from(actors).where(eq(actors.id, agentId))).toHaveLength(1)
			expect(await storage.exists(failingKey)).toBe(true)
		})

		it('leaves the folder alone when the agent is kept', async () => {
			const { item, agentId } = await installSingleAgent()
			await putMemory(agentId)

			const res = await createApp(storage).request(
				jsonRequest('DELETE', `/api/marketplace/items/${item.id}/uninstall`, {
					workspaceId,
					keepProvisionedItems: true,
				}),
			)
			expect(res.status).toBe(200)

			expect(await db.select().from(actors).where(eq(actors.id, agentId))).toHaveLength(1)
			for (const key of memoryKeys(workspaceId, agentId)) {
				expect(await storage.exists(key)).toBe(true)
			}
		})
	})
})
