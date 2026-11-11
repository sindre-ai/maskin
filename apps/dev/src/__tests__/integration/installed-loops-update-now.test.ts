import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	installedLoops,
	marketplaceLoopItems,
	marketplaceLoops,
	workspaceMembers,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { ViewerReadOnlyError } from '../../lib/workspace-auth'
import { AgentStorageManager } from '../../services/agent-storage'
import { insertActor, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId, sql as rawSql } from './global-setup'

const { default: installedLoopsRoutes } = await import('../../routes/installed-loops')

type Env = {
	Variables: {
		db: Database
		actorId: string
		agentStorage: AgentStorageManager
	}
}

/**
 * Minimal in-memory StorageProvider so the install/uninstall/fork paths exercise
 * the real S3 read/write/delete calls without needing SeaweedFS in CI. Mirrors
 * the helper in workspace-skills.test.ts.
 */
function createMemoryStorage(): StorageProvider & { _store: Map<string, Buffer> } {
	const store = new Map<string, Buffer>()
	return {
		_store: store,
		async put(key, data) {
			if (Buffer.isBuffer(data)) {
				store.set(key, data)
			} else if (data instanceof Uint8Array) {
				store.set(key, Buffer.from(data))
			} else {
				throw new Error('Streaming put not supported in memory storage')
			}
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

function createInstalledLoopsApp(storage: StorageProvider, actorId = getTestActorId()) {
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

	// The real app's onError turns a viewer's write attempt into a 403.
	app.onError((err, c) => {
		if (err instanceof ViewerReadOnlyError) {
			return c.json(createApiError('FORBIDDEN', err.message), 403)
		}
		throw err
	})

	const agentStorage = new AgentStorageManager(storage, db)

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('agentStorage', agentStorage)
		await next()
	})

	app.route('/api/installed-loops', installedLoopsRoutes)

	return app
}

// Fake values only. WORKSPACE_KEY stands for the key a workspace added to the
// installed agent itself; LEAKED_KEY for a key an old published snapshot may
// still carry. The update must keep the first and never write the second.
const WORKSPACE_KEY = 'fake-workspace-key-0001'
const LEAKED_KEY = 'fake-leaked-key-9999'

async function seedLoop() {
	const [loop] = await db
		.insert(marketplaceLoops)
		.values({
			name: 'Update Kit',
			slug: `update-kit-${randomUUID()}`,
			description: 'Loop used to test update now',
			version: '1.0.0',
			useCase: 'development',
		})
		.returning()
	if (!loop) throw new Error('marketplace_loops insert returned no row')
	const sourceActorId = randomUUID()
	await db.insert(marketplaceLoopItems).values({
		loopId: loop.id,
		itemType: 'actor',
		sourceItemId: sourceActorId,
		itemSnapshot: {
			type: 'agent',
			name: 'Update Bot',
			systemPrompt: 'Version one prompt.',
			llmProvider: 'anthropic',
			llmConfig: { provider: 'anthropic', model: 'model-old' },
			tools: {},
		},
	})
	return { loop, sourceActorId }
}

async function publishV2(loopId: string, sourceActorId: string) {
	await db.update(marketplaceLoops).set({ version: '1.1.0' }).where(eq(marketplaceLoops.id, loopId))
	await db
		.update(marketplaceLoopItems)
		.set({
			itemSnapshot: {
				type: 'agent',
				name: 'Update Bot',
				systemPrompt: 'Version two prompt.',
				llmProvider: 'anthropic',
				llmConfig: { provider: 'anthropic', model: 'model-new', apiKey: LEAKED_KEY },
				tools: {},
			},
		})
		.where(eq(marketplaceLoopItems.sourceItemId, sourceActorId))
}

async function installAndGiveAgentOwnKey(
	app: ReturnType<typeof createInstalledLoopsApp>,
	loopId: string,
	workspaceId: string,
	sourceActorId: string,
) {
	const res = await app.request(
		jsonRequest('POST', '/api/installed-loops', { loopId, workspaceId }),
	)
	expect(res.status).toBe(201)
	const installed = await res.json()
	const [agent] = await db
		.select({ id: actors.id, llmConfig: actors.llmConfig })
		.from(actors)
		.where(
			and(
				sql`${actors.metadata}->>'installed_loop_id' = ${installed.id}`,
				sql`${actors.metadata}->>'source_item_id' = ${sourceActorId}`,
			),
		)
	if (!agent) throw new Error('provisioned agent not found')
	// The workspace adds its own key and a setting of its own to the agent.
	await db
		.update(actors)
		.set({
			llmConfig: { ...(agent.llmConfig as object), apiKey: WORKSPACE_KEY, workspaceNote: 'mine' },
		})
		.where(eq(actors.id, agent.id))
	return { installed, agentId: agent.id }
}

const updateCall = (app: ReturnType<typeof createInstalledLoopsApp>, id: string) =>
	app.request(jsonRequest('POST', `/api/installed-loops/${id}/update`))

describe('POST /api/installed-loops/:id/update ("update now")', () => {
	let workspaceId: string
	let app: ReturnType<typeof createInstalledLoopsApp>

	beforeEach(async () => {
		await rawSql`TRUNCATE marketplace_loops, marketplace_loop_items CASCADE`
		const ws = await insertWorkspace(db, getTestActorId())
		if (!ws) throw new Error('workspace insert returned no row')
		workspaceId = ws.id
		app = createInstalledLoopsApp(createMemoryStorage())
	})

	it('brings a locked install to the new catalog version, attributes the event to the caller, and keeps the workspace key', async () => {
		const { loop, sourceActorId } = await seedLoop()
		const { installed, agentId } = await installAndGiveAgentOwnKey(
			app,
			loop.id,
			workspaceId,
			sourceActorId,
		)
		await publishV2(loop.id, sourceActorId)

		const res = await updateCall(app, installed.id)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({
			updated: true,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			installedVersion: '1.1.0',
			items: { updates: 1, adds: 0, removes: 0 },
		})

		const [install] = await db
			.select()
			.from(installedLoops)
			.where(eq(installedLoops.id, installed.id))
		expect(install?.installedVersion).toBe('1.1.0')

		const [agent] = await db.select().from(actors).where(eq(actors.id, agentId))
		expect(agent?.systemPrompt).toBe('Version two prompt.')
		const cfg = agent?.llmConfig as Record<string, unknown>
		expect(cfg.model).toBe('model-new')
		// The workspace's own key and setting survive; the snapshot's key never lands.
		expect(cfg.apiKey).toBe(WORKSPACE_KEY)
		expect(cfg.workspaceNote).toBe('mine')

		const evs = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, installed.id), eq(events.entityType, 'installed_loop')))
		const updated = evs.filter((e) => e.action === 'updated')
		expect(updated).toHaveLength(1)
		expect(updated[0]?.actorId).toBe(getTestActorId())
		expect(updated[0]?.data).toMatchObject({
			from_version: '1.0.0',
			to_version: '1.1.0',
			trigger: 'manual',
		})
	})

	it('changes nothing and says so when the install is already current', async () => {
		const { loop, sourceActorId } = await seedLoop()
		const { installed, agentId } = await installAndGiveAgentOwnKey(
			app,
			loop.id,
			workspaceId,
			sourceActorId,
		)
		const [before] = await db.select().from(actors).where(eq(actors.id, agentId))

		const res = await updateCall(app, installed.id)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({ updated: false, installedVersion: '1.0.0', items: null })
		expect(body.message).toContain('Already up to date')

		const [after] = await db.select().from(actors).where(eq(actors.id, agentId))
		expect(after).toEqual(before)
		const evs = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, installed.id), eq(events.action, 'updated')))
		expect(evs).toHaveLength(0)
	})

	it('two calls at once apply the update once (row lock + version re-check)', async () => {
		const { loop, sourceActorId } = await seedLoop()
		const { installed } = await installAndGiveAgentOwnKey(app, loop.id, workspaceId, sourceActorId)
		await publishV2(loop.id, sourceActorId)

		const [a, b] = await Promise.all([updateCall(app, installed.id), updateCall(app, installed.id)])
		expect(a.status).toBe(200)
		expect(b.status).toBe(200)
		const bodies = [await a.json(), await b.json()]
		expect(bodies.filter((x) => x.updated)).toHaveLength(1)

		const evs = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, installed.id), eq(events.action, 'updated')))
		expect(evs).toHaveLength(1)
	})

	it('refuses a forked install with a 409 and leaves it on its old version', async () => {
		const { loop, sourceActorId } = await seedLoop()
		const { installed } = await installAndGiveAgentOwnKey(app, loop.id, workspaceId, sourceActorId)
		const fork = await app.request(jsonRequest('POST', `/api/installed-loops/${installed.id}/fork`))
		expect(fork.status).toBe(200)
		await publishV2(loop.id, sourceActorId)

		const res = await updateCall(app, installed.id)
		expect(res.status).toBe(409)
		const body = await res.json()
		expect(body.error.message).toContain('forked')

		const [install] = await db
			.select()
			.from(installedLoops)
			.where(eq(installedLoops.id, installed.id))
		expect(install?.installedVersion).toBe('1.0.0')
	})

	it('gives a viewer and a non-member a 403 and writes nothing', async () => {
		const { loop, sourceActorId } = await seedLoop()
		const { installed } = await installAndGiveAgentOwnKey(app, loop.id, workspaceId, sourceActorId)
		await publishV2(loop.id, sourceActorId)

		const viewer = await insertActor(db)
		await db.insert(workspaceMembers).values({ workspaceId, actorId: viewer.id, role: 'viewer' })
		const outsider = await insertActor(db)

		for (const actorId of [viewer.id, outsider.id]) {
			const res = await updateCall(
				createInstalledLoopsApp(createMemoryStorage(), actorId),
				installed.id,
			)
			expect(res.status).toBe(403)
		}
		const [install] = await db
			.select()
			.from(installedLoops)
			.where(eq(installedLoops.id, installed.id))
		expect(install?.installedVersion).toBe('1.0.0')
	})

	it('returns 404 for an install that does not exist', async () => {
		const res = await updateCall(app, randomUUID())
		expect(res.status).toBe(404)
	})
})
