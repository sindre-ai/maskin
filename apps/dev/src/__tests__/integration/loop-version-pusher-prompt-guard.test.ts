import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	actors,
	installedLoops,
	marketplaceLoopItems,
	marketplaceLoops,
	workspaceMembers,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@sentry/node', () => ({
	init: vi.fn(),
	captureException: vi.fn(),
	captureMessage: vi.fn(),
	addBreadcrumb: vi.fn(),
}))

import * as Sentry from '@sentry/node'
import { createApiError, formatZodError } from '../../lib/errors'
import { AgentStorageManager } from '../../services/agent-storage'
import { LoopVersionPusher } from '../../services/loop-version-pusher'
import { insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId, sql as rawSql } from './global-setup'

const { default: installedLoopsRoutes } = await import('../../routes/installed-loops')

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
		async ensureBucket() {},
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
	return app
}

type ActorItem = { sourceItemId: string; snapshot: Record<string, unknown> }

async function seedMarketplaceLoop(opts: {
	name: string
	version?: string
	actorItems: ActorItem[]
}) {
	const [loop] = await db
		.insert(marketplaceLoops)
		.values({
			name: opts.name,
			slug: `${opts.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID()}`,
			description: `${opts.name} loop`,
			version: opts.version ?? '1.0.0',
			useCase: 'growth',
		})
		.returning()
	if (!loop) throw new Error('marketplace_loops insert returned no row')

	const items = opts.actorItems.map((a) => ({
		loopId: loop.id,
		itemType: 'actor' as const,
		sourceItemId: a.sourceItemId,
		itemSnapshot: a.snapshot,
	}))
	if (items.length > 0) await db.insert(marketplaceLoopItems).values(items)
	return loop
}

async function install(app: ReturnType<typeof makeApp>, loopId: string, workspaceId: string) {
	const res = await app.request(
		jsonRequest('POST', '/api/installed-loops', { loopId, workspaceId }),
	)
	return { status: res.status, body: (await res.json()) as { provisioned: { actors: number } } }
}

async function findActor(workspaceId: string, sourceItemId: string) {
	const [row] = await db
		.select({
			id: actors.id,
			name: actors.name,
			description: actors.description,
			systemPrompt: actors.systemPrompt,
			tools: actors.tools,
		})
		.from(actors)
		.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				sql`${actors.metadata}->>'source_item_id' = ${sourceItemId}`,
			),
		)
	return row
}

const LONG_PROMPT = 'You are a diligent analyst. '.repeat(20)

const BASE_ACTOR_SNAPSHOT = {
	type: 'agent',
	name: 'Analyst',
	description: 'Digs into signal.',
	systemPrompt: LONG_PROMPT,
	llmProvider: 'anthropic',
	llmConfig: {},
	tools: { web_search: true },
} as const

describe('Loop-version-pusher — system prompt guard', () => {
	let workspaceId: string
	let actorId: string
	const captureMessage = vi.mocked(Sentry.captureMessage)

	beforeEach(async () => {
		await rawSql`TRUNCATE marketplace_loops, marketplace_loop_items CASCADE`
		await rawSql`TRUNCATE installed_loops CASCADE`
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		if (!ws) throw new Error('workspace insert returned no row')
		workspaceId = ws.id
		captureMessage.mockClear()
	})

	it('preserves systemPrompt on the pushLockedInstall path when the snapshot nulls it, updates every other field, and emits one Sentry warning', async () => {
		const sourceActorId = randomUUID()
		const loop = await seedMarketplaceLoop({
			name: 'Locked install loop',
			version: '1.0.0',
			actorItems: [{ sourceItemId: sourceActorId, snapshot: BASE_ACTOR_SNAPSHOT }],
		})
		const app = makeApp(actorId)
		const first = await install(app, loop.id, workspaceId)
		expect(first.status).toBe(201)

		const before = await findActor(workspaceId, sourceActorId)
		if (!before) throw new Error('expected the installed actor row')
		expect(before.systemPrompt).toBe(LONG_PROMPT)

		// Publish v2 with systemPrompt nulled but every other field updated.
		await db
			.update(marketplaceLoops)
			.set({ version: '2.0.0' })
			.where(eq(marketplaceLoops.id, loop.id))
		await db
			.update(marketplaceLoopItems)
			.set({
				itemSnapshot: {
					type: 'agent',
					name: 'Analyst v2',
					description: 'Digs into signal (v2).',
					systemPrompt: null,
					llmProvider: 'anthropic',
					llmConfig: {},
					tools: { web_search: true, browser: true },
				},
			})
			.where(
				and(
					eq(marketplaceLoopItems.loopId, loop.id),
					eq(marketplaceLoopItems.sourceItemId, sourceActorId),
				),
			)

		const pusher = new LoopVersionPusher(
			db,
			new AgentStorageManager(createMemoryStorage(), db),
			60_000,
		)
		await expect(pusher.tick()).resolves.toBeUndefined()

		const after = await findActor(workspaceId, sourceActorId)
		expect(after?.systemPrompt).toBe(LONG_PROMPT)
		expect(after?.name).toBe('Analyst v2')
		expect(after?.description).toBe('Digs into signal (v2).')
		// tools expanded by expandBrowserCapability — the browser flag turns into
		// a playwright MCP server entry. What matters here is that the update
		// landed and reshaped the row's tools (the pre-refactor snapshot had no
		// browser flag), NOT the exact expansion shape.
		expect(after?.tools).not.toEqual(BASE_ACTOR_SNAPSHOT.tools)

		expect(captureMessage).toHaveBeenCalledTimes(1)
		const [event, hint] = captureMessage.mock.calls[0] ?? []
		expect(event).toBe('system_prompt_corruption_prevented')
		expect(hint).toMatchObject({
			level: 'warning',
			extra: expect.objectContaining({
				cause: 'null_write',
				writePath: 'loop_version_pusher_locked_install',
				actorId: before.id,
				workspaceId,
				previousLength: LONG_PROMPT.length,
				attemptedLength: 0,
			}),
		})

		// Install advanced to the new version — field-skip, not tick-skip.
		const [installRow] = await db
			.select({ installedVersion: installedLoops.installedVersion })
			.from(installedLoops)
			.where(eq(installedLoops.sourceLoopId, loop.id))
		expect(installRow?.installedVersion).toBe('2.0.0')
	})

	it('preserves systemPrompt on the actor-reuse dedup path when the snapshot nulls it, with the dedup write_path label', async () => {
		// Loop A owns its own actor. Loop B holds the shared actor at v1.
		const loopAOwnActorId = randomUUID()
		const sharedSourceActorId = randomUUID()
		const loopA = await seedMarketplaceLoop({
			name: 'Loop A',
			version: '1.0.0',
			actorItems: [{ sourceItemId: loopAOwnActorId, snapshot: BASE_ACTOR_SNAPSHOT }],
		})
		const loopB = await seedMarketplaceLoop({
			name: 'Loop B',
			version: '1.0.0',
			actorItems: [{ sourceItemId: sharedSourceActorId, snapshot: BASE_ACTOR_SNAPSHOT }],
		})
		const app = makeApp(actorId)
		await install(app, loopA.id, workspaceId)
		await install(app, loopB.id, workspaceId)

		const before = await findActor(workspaceId, sharedSourceActorId)
		if (!before) throw new Error('expected the shared actor row from Loop B')
		expect(before.systemPrompt).toBe(LONG_PROMPT)

		// Publish Loop A v2 that ADDS the shared actor with a null systemPrompt —
		// triggers the actor-reuse dedup path when Loop A's push runs.
		await db
			.update(marketplaceLoops)
			.set({ version: '2.0.0' })
			.where(eq(marketplaceLoops.id, loopA.id))
		await db.insert(marketplaceLoopItems).values({
			loopId: loopA.id,
			itemType: 'actor',
			sourceItemId: sharedSourceActorId,
			itemSnapshot: {
				...BASE_ACTOR_SNAPSHOT,
				name: 'Analyst v2 dedup',
				systemPrompt: null,
			},
		})

		const pusher = new LoopVersionPusher(
			db,
			new AgentStorageManager(createMemoryStorage(), db),
			60_000,
		)
		await expect(pusher.tick()).resolves.toBeUndefined()

		const after = await findActor(workspaceId, sharedSourceActorId)
		expect(after?.id).toBe(before.id)
		expect(after?.systemPrompt).toBe(LONG_PROMPT)
		expect(after?.name).toBe('Analyst v2 dedup')

		const dedupCalls = captureMessage.mock.calls.filter(([evt, hint]) => {
			const extra = (hint as { extra?: { writePath?: string } } | undefined)?.extra
			return (
				evt === 'system_prompt_corruption_prevented' &&
				extra?.writePath === 'loop_version_pusher_dedup'
			)
		})
		expect(dedupCalls).toHaveLength(1)
		const [, hint] = dedupCalls[0] ?? []
		expect(hint).toMatchObject({
			level: 'warning',
			extra: expect.objectContaining({
				cause: 'null_write',
				writePath: 'loop_version_pusher_dedup',
				actorId: before.id,
				workspaceId,
				previousLength: LONG_PROMPT.length,
			}),
		})
	})

	it('writes a shorter non-empty systemPrompt through — the guard does not block a shrink to a non-empty value', async () => {
		const sourceActorId = randomUUID()
		const loop = await seedMarketplaceLoop({
			name: 'Shrink loop',
			version: '1.0.0',
			actorItems: [{ sourceItemId: sourceActorId, snapshot: BASE_ACTOR_SNAPSHOT }],
		})
		const app = makeApp(actorId)
		await install(app, loop.id, workspaceId)

		const shorterPrompt = 'Be concise.'
		await db
			.update(marketplaceLoops)
			.set({ version: '2.0.0' })
			.where(eq(marketplaceLoops.id, loop.id))
		await db
			.update(marketplaceLoopItems)
			.set({
				itemSnapshot: {
					...BASE_ACTOR_SNAPSHOT,
					systemPrompt: shorterPrompt,
				},
			})
			.where(
				and(
					eq(marketplaceLoopItems.loopId, loop.id),
					eq(marketplaceLoopItems.sourceItemId, sourceActorId),
				),
			)

		const pusher = new LoopVersionPusher(
			db,
			new AgentStorageManager(createMemoryStorage(), db),
			60_000,
		)
		await pusher.tick()

		const after = await findActor(workspaceId, sourceActorId)
		expect(after?.systemPrompt).toBe(shorterPrompt)
		expect(captureMessage).not.toHaveBeenCalled()
	})
})
