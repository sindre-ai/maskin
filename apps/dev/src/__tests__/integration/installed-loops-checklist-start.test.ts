import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, actors, marketplaceLoops, objects } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { seedMarketplaceLoops } from '../../lib/dev-bootstrap'
import { createApiError, formatZodError } from '../../lib/errors'
import { readLoopSettings } from '../../lib/marketplace-loops/loop-settings'
import { AgentStorageManager } from '../../services/agent-storage'
import {
	buildChecklistStartPrompt,
	provisionLoopChecklist,
	startLoopChecklistSession,
} from '../../services/loop-checklist-provisioning'
import {
	bootstrapDefaultAgents,
	installDefaultMarketplaceLoops,
} from '../../services/workspace-bootstrap'
import { insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId, sql as rawSql } from './global-setup'

// Starting a real agent session needs a model; what matters here is the one request the install
// makes for the checklist's driver.
const startSession = vi.hoisted(() => vi.fn(async () => ({ sessionId: 'session-1' })))
vi.mock('../../services/session-lifecycle', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../services/session-lifecycle')>()),
	startSession,
}))

const { default: installedLoopsRoutes } = await import('../../routes/installed-loops')

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		agentStorage: AgentStorageManager
		storageProvider: StorageProvider
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
	const storage = createMemoryStorage()
	const agentStorage = new AgentStorageManager(storage, db)
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('agentStorage', agentStorage)
		c.set('storageProvider', storage)
		await next()
	})
	app.route('/api/installed-loops', installedLoopsRoutes)
	return app
}

// The install starts the flow's driver on its checklist right after it commits, for every flow that
// ships one, so the installer does not wait for the next owner check.
describe('Marketplace install — checklist driver starts right away', () => {
	let seededLoops: Array<{ id: string; slug: string; loopSettings: unknown }>

	beforeAll(async () => {
		await rawSql`TRUNCATE marketplace_loops, marketplace_loop_items CASCADE`
		await seedMarketplaceLoops(db)
		seededLoops = await db
			.select({
				id: marketplaceLoops.id,
				slug: marketplaceLoops.slug,
				loopSettings: marketplaceLoops.loopSettings,
			})
			.from(marketplaceLoops)
	})

	beforeEach(async () => {
		await rawSql`TRUNCATE installed_loops CASCADE`
		startSession.mockReset()
		startSession.mockResolvedValue({ sessionId: 'session-1' })
	})

	async function install(slug: string) {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		if (!ws) throw new Error('workspace insert returned no row')
		const agentStorage = new AgentStorageManager(createMemoryStorage(), db)
		await bootstrapDefaultAgents(db, agentStorage, ws.id, actorId)
		const loop = seededLoops.find((l) => l.slug === slug)
		if (!loop) throw new Error(`seeded loop ${slug} not found`)
		const res = await makeApp(actorId).request(
			jsonRequest('POST', '/api/installed-loops', { loopId: loop.id, workspaceId: ws.id }),
		)
		const body = (await res.json()) as { id: string; objectId: string }
		return { res, body, ws, actorId, loop }
	}

	const DRIVERS = [
		['knowledge-wiki-loop', 'Knowledge Curator'],
		['market-competitor-watch-loop', 'Market Researcher'],
	] as const

	for (const [slug, driverName] of DRIVERS) {
		it(`${slug}: one start request for the driver, none on a repeat`, async () => {
			const { res, body, ws, actorId, loop } = await install(slug)
			expect(res.status).toBe(201)

			const tasks = await db
				.select()
				.from(objects)
				.where(and(eq(objects.workspaceId, ws.id), eq(objects.type, 'task')))
			const parent = tasks.find(
				(t) => (t.metadata as { checklist_role?: string } | null)?.checklist_role === 'parent',
			)
			if (!parent) throw new Error('checklist parent task not found')

			expect(startSession).toHaveBeenCalledTimes(1)
			const call = startSession.mock.calls[0] as unknown as [Record<string, unknown>]
			const input = call[0]
			const driverIds = (await db.select({ id: actors.id, name: actors.name }).from(actors))
				.filter((a) => a.name === driverName)
				.map((a) => a.id)
			expect(driverIds).toContain(input.actorId)
			expect(input.workspaceId).toBe(ws.id)
			expect(input.createdBy).toBe(actorId)
			expect(input.initiatedFromObjectId).toBe(parent.id)
			expect(input.config).toEqual({ idempotencyKey: `loop-checklist-start:${body.id}` })
			expect(String(input.actionPrompt)).toContain(body.objectId)
			expect(String(input.actionPrompt)).toContain(parent.id)

			// A repeat provisioning call creates no tasks and returns no parent, so nothing starts.
			const checklist = readLoopSettings(loop.loopSettings)?.checklist
			if (!checklist) throw new Error('checklist missing')
			const again = await provisionLoopChecklist({
				db,
				workspaceId: ws.id,
				actorId,
				installId: body.id,
				loopObjectId: body.objectId,
				checklist,
				driverActorId: String(input.actorId),
			})
			expect(again).toEqual({ created: 0, parentTaskId: null })
			expect(startSession).toHaveBeenCalledTimes(1)
		})
	}

	// A new workspace gets Knowledge Wiki through the same shared install, so it starts the driver
	// too, unless the caller says the workspace may not run sessions yet (waiting for its card).
	describe('new workspace install', () => {
		async function installForNewWorkspace(options?: { startChecklist?: boolean }) {
			const actorId = getTestActorId()
			const ws = await insertWorkspace(db, actorId)
			if (!ws) throw new Error('workspace insert returned no row')
			const storage = createMemoryStorage()
			const agentStorage = new AgentStorageManager(storage, db)
			await bootstrapDefaultAgents(db, agentStorage, ws.id, actorId)
			await installDefaultMarketplaceLoops(db, agentStorage, storage, ws.id, actorId, options)
			// A second run finds the flow installed and starts nothing.
			await installDefaultMarketplaceLoops(db, agentStorage, storage, ws.id, actorId, options)
			return ws
		}

		it('starts the driver once when the workspace may run sessions', async () => {
			const ws = await installForNewWorkspace({ startChecklist: true })
			expect(startSession).toHaveBeenCalledTimes(1)
			const call = startSession.mock.calls[0] as unknown as [Record<string, unknown>]
			expect(call[0].workspaceId).toBe(ws.id)
		})

		it('starts nothing while the workspace waits for its card', async () => {
			await installForNewWorkspace({ startChecklist: false })
			expect(startSession).not.toHaveBeenCalled()
		})
	})

	it('keeps the install and says so on the flow when the agent cannot start', async () => {
		startSession.mockRejectedValue(new Error('no model access'))
		const { res, body, ws } = await install('knowledge-wiki-loop')
		expect(res.status).toBe(201)

		const tasks = await db
			.select({ id: objects.id })
			.from(objects)
			.where(and(eq(objects.workspaceId, ws.id), eq(objects.type, 'task')))
		expect(tasks).toHaveLength(12)

		const comments = await db
			.select({ data: events.data })
			.from(events)
			.where(and(eq(events.entityId, body.objectId), eq(events.action, 'commented')))
		expect(comments).toHaveLength(1)
		expect(JSON.stringify(comments[0]?.data)).toContain('next owner check')
	})

	it('starts nothing when the checklist has no driver', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		if (!ws) throw new Error('workspace insert returned no row')
		const start = vi.fn()
		const out = await startLoopChecklistSession(
			{
				db,
				workspaceId: ws.id,
				installerId: actorId,
				installId: 'install-1',
				loop: { objectId: 'loop-1', name: 'Flow' },
				parentTaskId: 'task-1',
				driverActorId: null,
			},
			{ start },
		)
		expect(out).toEqual({ started: false })
		expect(start).not.toHaveBeenCalled()
	})

	it('builds a prompt that names the flow, the checklist and the 3 question limit', () => {
		const prompt = buildChecklistStartPrompt({
			loopName: 'Knowledge Wiki',
			loopObjectId: 'loop-object-id',
			parentTaskId: 'parent-task-id',
		})
		expect(prompt).toContain('Knowledge Wiki')
		expect(prompt).toContain('loop-object-id')
		expect(prompt).toContain('parent-task-id')
		expect(prompt).toContain('at most 3 questions')
	})
})
