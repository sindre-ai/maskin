import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	installedLoops,
	marketplaceLoopItems,
	marketplaceLoops,
	triggers,
	workspaceMembers,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, desc, eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
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
	return app
}

type ActorItem = { sourceItemId: string; snapshot: Record<string, unknown> }
type TriggerItem = { sourceItemId: string; snapshot: Record<string, unknown> }

/**
 * Seed a marketplace loop from bare source items. Returns the loop row plus
 * the source actor/trigger ids referenced by the caller's items.
 */
async function seedMarketplaceLoop(opts: {
	name: string
	version?: string
	actorItems: ActorItem[]
	triggerItems?: TriggerItem[]
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

	const items = [
		...opts.actorItems.map((a) => ({
			loopId: loop.id,
			itemType: 'actor' as const,
			sourceItemId: a.sourceItemId,
			itemSnapshot: a.snapshot,
		})),
		...(opts.triggerItems ?? []).map((t) => ({
			loopId: loop.id,
			itemType: 'trigger' as const,
			sourceItemId: t.sourceItemId,
			itemSnapshot: t.snapshot,
		})),
	]
	await db.insert(marketplaceLoopItems).values(items)
	return loop
}

/** Count actor rows in the workspace provisioned from a given marketplace source item. */
async function countActorsFromSourceItem(workspaceId: string, sourceItemId: string) {
	const rows = await db
		.select({ id: actors.id })
		.from(actors)
		.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				sql`${actors.metadata}->>'source_item_id' = ${sourceItemId}`,
			),
		)
	return rows
}

async function install(app: ReturnType<typeof makeApp>, loopId: string, workspaceId: string) {
	const res = await app.request(
		jsonRequest('POST', '/api/installed-loops', { loopId, workspaceId }),
	)
	return { status: res.status, body: (await res.json()) as { provisioned: { actors: number } } }
}

const AGENT_SNAPSHOT = {
	type: 'agent',
	name: 'Shared Agent',
	description: 'Bundled in more than one loop',
	systemPrompt: 'Be helpful.',
	llmProvider: 'anthropic',
	llmConfig: {},
	tools: {},
} as const

describe('Loop install dedup guard', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		await rawSql`TRUNCATE marketplace_loops, marketplace_loop_items CASCADE`
		await rawSql`TRUNCATE installed_loops CASCADE`
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		if (!ws) throw new Error('workspace insert returned no row')
		workspaceId = ws.id
	})

	it('two loops that bundle the same agent leave exactly one copy in the workspace, and both triggers target it', async () => {
		const sharedSourceActorId = randomUUID()
		const loopA = await seedMarketplaceLoop({
			name: 'Loop A',
			actorItems: [{ sourceItemId: sharedSourceActorId, snapshot: AGENT_SNAPSHOT }],
			triggerItems: [
				{
					sourceItemId: randomUUID(),
					snapshot: {
						name: 'Loop A daily',
						type: 'cron',
						config: { expression: '0 9 * * *' },
						actionPrompt: 'Run A.',
						target_actor_id: sharedSourceActorId,
						enabled: true,
					},
				},
			],
		})
		const loopB = await seedMarketplaceLoop({
			name: 'Loop B',
			actorItems: [{ sourceItemId: sharedSourceActorId, snapshot: AGENT_SNAPSHOT }],
			triggerItems: [
				{
					sourceItemId: randomUUID(),
					snapshot: {
						name: 'Loop B daily',
						type: 'cron',
						config: { expression: '0 10 * * *' },
						actionPrompt: 'Run B.',
						target_actor_id: sharedSourceActorId,
						enabled: true,
					},
				},
			],
		})
		const app = makeApp(actorId)

		const first = await install(app, loopA.id, workspaceId)
		expect(first.status).toBe(201)
		expect(first.body.provisioned.actors).toBe(1)

		// Second loop bundles the SAME agent — it must reuse, not clone.
		const second = await install(app, loopB.id, workspaceId)
		expect(second.status).toBe(201)
		expect(second.body.provisioned.actors).toBe(0)

		const copies = await countActorsFromSourceItem(workspaceId, sharedSourceActorId)
		expect(copies).toHaveLength(1)
		const reuseId = copies[0]?.id
		if (!reuseId) throw new Error('expected a reused actor row')

		// Both loops' triggers wire to the single reused agent.
		const [loopAInstall] = await db
			.select({ id: installedLoops.id })
			.from(installedLoops)
			.where(eq(installedLoops.sourceLoopId, loopA.id))
		const [loopBInstall] = await db
			.select({ id: installedLoops.id })
			.from(installedLoops)
			.where(eq(installedLoops.sourceLoopId, loopB.id))
		const triggerRows = await db
			.select({ targetActorId: triggers.targetActorId })
			.from(triggers)
			.where(
				sql`${triggers.metadata}->>'installed_loop_id' IN (${loopAInstall.id}, ${loopBInstall.id})`,
			)
		expect(triggerRows).toHaveLength(2)
		for (const row of triggerRows) {
			expect(row.targetActorId).toBe(reuseId)
		}
	})

	it('re-installing a loop after a keep-items uninstall reuses the kept agent instead of cloning', async () => {
		const sharedSourceActorId = randomUUID()
		const loopA = await seedMarketplaceLoop({
			name: 'Loop A',
			actorItems: [{ sourceItemId: sharedSourceActorId, snapshot: AGENT_SNAPSHOT }],
		})
		const app = makeApp(actorId)

		const first = await install(app, loopA.id, workspaceId)
		expect(first.status).toBe(201)
		expect(first.body.provisioned.actors).toBe(1)

		// Uninstall but keep provisioned items — the agent stays a workspace member.
		const [installRow] = await db
			.select({ id: installedLoops.id })
			.from(installedLoops)
			.where(eq(installedLoops.sourceLoopId, loopA.id))
		if (!installRow) throw new Error('install row not found')
		const uninstallRes = await app.request(
			jsonRequest('DELETE', `/api/installed-loops/${installRow.id}`, {
				keepProvisionedItems: true,
			}),
		)
		expect(uninstallRes.status).toBe(200)

		// Re-install the same loop — the kept agent matches by source_item_id.
		const second = await install(app, loopA.id, workspaceId)
		expect(second.status).toBe(201)
		expect(second.body.provisioned.actors).toBe(0)

		const copies = await countActorsFromSourceItem(workspaceId, sharedSourceActorId)
		expect(copies).toHaveLength(1)
	})

	it('the version-push cron reuses an agent another loop already provisioned instead of cloning it', async () => {
		// Loop A v1's own agent; loop A's trigger targets it (local wiring).
		const loopAOwneActorId = randomUUID()
		// The agent shared between Loop B and the actor Loop A gains in v2.
		const sharedSourceActorId = randomUUID()
		const loopA = await seedMarketplaceLoop({
			name: 'Loop A',
			version: '1.0.0',
			actorItems: [{ sourceItemId: loopAOwneActorId, snapshot: AGENT_SNAPSHOT }],
			triggerItems: [
				{
					sourceItemId: randomUUID(),
					snapshot: {
						name: 'Loop A daily',
						type: 'cron',
						config: { expression: '0 9 * * *' },
						actionPrompt: 'Run A.',
						target_actor_id: loopAOwneActorId,
						enabled: true,
					},
				},
			],
		})
		// The second loop already installs the actor the cron is about to add.
		const loopB = await seedMarketplaceLoop({
			name: 'Loop B',
			actorItems: [{ sourceItemId: sharedSourceActorId, snapshot: AGENT_SNAPSHOT }],
		})
		const app = makeApp(actorId)

		await install(app, loopA.id, workspaceId)
		await install(app, loopB.id, workspaceId)
		const before = await countActorsFromSourceItem(workspaceId, sharedSourceActorId)
		expect(before).toHaveLength(1)

		// Publish Loop A v2 that now includes the shared agent as a new item.
		const loopAid = loopA.id
		await db
			.update(marketplaceLoops)
			.set({ version: '2.0.0' })
			.where(eq(marketplaceLoops.id, loopAid))
		await db.insert(marketplaceLoopItems).values({
			loopId: loopAid,
			itemType: 'actor',
			sourceItemId: sharedSourceActorId,
			itemSnapshot: AGENT_SNAPSHOT,
		})

		const pusher = new LoopVersionPusher(
			db,
			new AgentStorageManager(createMemoryStorage(), db),
			60_000,
		)
		await pusher.tick()

		const after = await countActorsFromSourceItem(workspaceId, sharedSourceActorId)
		expect(after).toHaveLength(1)
		expect(after[0]?.id).toBe(before[0]?.id)

		// And the install was advanced to the new version.
		const [row] = await db
			.select({ installedVersion: installedLoops.installedVersion })
			.from(installedLoops)
			.where(eq(installedLoops.sourceLoopId, loopAid))
		expect(row?.installedVersion).toBe('2.0.0')
	})

	it('installing the same loop into two workspaces provisions one distinct agent per workspace', async () => {
		const sourceActorId = randomUUID()
		const loop = await seedMarketplaceLoop({
			name: 'Shared Loop',
			actorItems: [{ sourceItemId: sourceActorId, snapshot: AGENT_SNAPSHOT }],
		})
		const otherWorkspace = await insertWorkspace(db, actorId)
		if (!otherWorkspace) throw new Error('second workspace insert returned no row')
		const app = makeApp(actorId)

		const first = await install(app, loop.id, workspaceId)
		expect(first.status).toBe(201)
		expect(first.body.provisioned.actors).toBe(1)

		// Same loop, second workspace — the workspace_members join scopes the
		// dedup, so this install mints its own copy instead of reusing the first
		// workspace's agent across workspace boundaries.
		const second = await install(app, loop.id, otherWorkspace.id)
		expect(second.status).toBe(201)
		expect(second.body.provisioned.actors).toBe(1)

		const inFirst = await countActorsFromSourceItem(workspaceId, sourceActorId)
		const inSecond = await countActorsFromSourceItem(otherWorkspace.id, sourceActorId)
		expect(inFirst).toHaveLength(1)
		expect(inSecond).toHaveLength(1)
		expect(inFirst[0]?.id).not.toBe(inSecond[0]?.id)
	})

	it('a v2 push that adds a trigger targeting a reused agent wires the trigger to the reused id and re-snapshots the agent', async () => {
		const sharedSourceActorId = randomUUID()
		const triggerSourceId = randomUUID()
		const v2Snapshot = {
			...AGENT_SNAPSHOT,
			systemPrompt: 'Be helpful, now shipping at v2.',
		}
		const loopA = await seedMarketplaceLoop({
			name: 'Loop A',
			version: '1.0.0',
			actorItems: [{ sourceItemId: randomUUID(), snapshot: AGENT_SNAPSHOT }],
		})
		const loopB = await seedMarketplaceLoop({
			name: 'Loop B',
			actorItems: [{ sourceItemId: sharedSourceActorId, snapshot: AGENT_SNAPSHOT }],
		})
		const app = makeApp(actorId)

		await install(app, loopA.id, workspaceId)
		await install(app, loopB.id, workspaceId)
		const [reused] = await countActorsFromSourceItem(workspaceId, sharedSourceActorId)
		if (!reused) throw new Error('expected the shared agent provisioned by Loop B')

		// Loop A v2 adds the shared agent (with new config) and a trigger targeting it.
		await db
			.update(marketplaceLoops)
			.set({ version: '2.0.0' })
			.where(eq(marketplaceLoops.id, loopA.id))
		await db.insert(marketplaceLoopItems).values({
			loopId: loopA.id,
			itemType: 'actor',
			sourceItemId: sharedSourceActorId,
			itemSnapshot: v2Snapshot,
		})
		await db.insert(marketplaceLoopItems).values({
			loopId: loopA.id,
			itemType: 'trigger',
			sourceItemId: triggerSourceId,
			itemSnapshot: {
				name: 'Loop A v2 daily',
				type: 'cron',
				config: { expression: '0 11 * * *' },
				actionPrompt: 'Run A v2.',
				target_actor_id: sharedSourceActorId,
				enabled: true,
			},
		})

		const pusher = new LoopVersionPusher(
			db,
			new AgentStorageManager(createMemoryStorage(), db),
			60_000,
		)
		await pusher.tick()

		// Still exactly one copy — the reused row, not a clone.
		const copies = await countActorsFromSourceItem(workspaceId, sharedSourceActorId)
		expect(copies).toHaveLength(1)
		expect(copies[0]?.id).toBe(reused.id)

		// The reused agent was re-snapshotted to the version being pushed.
		const [actorRow] = await db
			.select({ systemPrompt: actors.systemPrompt })
			.from(actors)
			.where(eq(actors.id, reused.id))
		expect(actorRow?.systemPrompt).toBe('Be helpful, now shipping at v2.')

		// The v2 trigger is wired to the reused agent id, not the source id.
		const [installRow] = await db
			.select({ id: installedLoops.id })
			.from(installedLoops)
			.where(eq(installedLoops.sourceLoopId, loopA.id))
		if (!installRow) throw new Error('install row not found')
		const triggerRows = await db
			.select({ targetActorId: triggers.targetActorId })
			.from(triggers)
			.where(sql`${triggers.metadata}->>'installed_loop_id' = ${installRow.id}`)
		expect(triggerRows).toHaveLength(1)
		expect(triggerRows[0]?.targetActorId).toBe(reused.id)
	})

	it('the version-push cron counts a reused agent as a reuse — never an add — and does not phantom-add it on later ticks', async () => {
		const sharedSourceActorId = randomUUID()
		const loopA = await seedMarketplaceLoop({
			name: 'Loop A',
			version: '1.0.0',
			actorItems: [{ sourceItemId: randomUUID(), snapshot: AGENT_SNAPSHOT }],
		})
		const loopB = await seedMarketplaceLoop({
			name: 'Loop B',
			actorItems: [{ sourceItemId: sharedSourceActorId, snapshot: AGENT_SNAPSHOT }],
		})
		const app = makeApp(actorId)

		await install(app, loopA.id, workspaceId)
		await install(app, loopB.id, workspaceId)

		// Loop A v2 adds the agent Loop B already provisioned.
		await db
			.update(marketplaceLoops)
			.set({ version: '2.0.0' })
			.where(eq(marketplaceLoops.id, loopA.id))
		await db.insert(marketplaceLoopItems).values({
			loopId: loopA.id,
			itemType: 'actor',
			sourceItemId: sharedSourceActorId,
			itemSnapshot: AGENT_SNAPSHOT,
		})

		const pusher = new LoopVersionPusher(
			db,
			new AgentStorageManager(createMemoryStorage(), db),
			60_000,
		)
		await pusher.tick()

		const [installRow] = await db
			.select({ id: installedLoops.id })
			.from(installedLoops)
			.where(eq(installedLoops.sourceLoopId, loopA.id))
		if (!installRow) throw new Error('install row not found')

		// The reuse is accounted as a reuse, not as an add.
		const [firstPush] = await db
			.select({ data: events.data })
			.from(events)
			.where(
				and(
					eq(events.entityType, 'installed_loop'),
					eq(events.entityId, installRow.id),
					eq(events.action, 'updated'),
				),
			)
		expect(firstPush?.data).toMatchObject({
			items: { adds: 0, updates: 0, removes: 0, reuses: 1 },
		})

		// A later push to a version with identical items must not count the
		// reused agent again — the re-stamped metadata makes it an owned row
		// that diffs as unchanged.
		await db
			.update(marketplaceLoops)
			.set({ version: '3.0.0' })
			.where(eq(marketplaceLoops.id, loopA.id))
		await pusher.tick()

		const [secondPush] = await db
			.select({ data: events.data })
			.from(events)
			.where(
				and(
					eq(events.entityType, 'installed_loop'),
					eq(events.entityId, installRow.id),
					eq(events.action, 'updated'),
				),
			)
			.orderBy(desc(events.id))
		expect(secondPush?.data).toMatchObject({
			items: { adds: 0, updates: 0, removes: 0, reuses: 0 },
		})
	})

	it("fully uninstalling the loop that first provisioned a shared agent keeps the agent and the other loop's trigger", async () => {
		const sharedSourceActorId = randomUUID()
		const loopA = await seedMarketplaceLoop({
			name: 'Loop A',
			actorItems: [{ sourceItemId: sharedSourceActorId, snapshot: AGENT_SNAPSHOT }],
			triggerItems: [
				{
					sourceItemId: randomUUID(),
					snapshot: {
						name: 'Loop A daily',
						type: 'cron',
						config: { expression: '0 9 * * *' },
						actionPrompt: 'Run A.',
						target_actor_id: sharedSourceActorId,
						enabled: true,
					},
				},
			],
		})
		const loopB = await seedMarketplaceLoop({
			name: 'Loop B',
			actorItems: [{ sourceItemId: sharedSourceActorId, snapshot: AGENT_SNAPSHOT }],
			triggerItems: [
				{
					sourceItemId: randomUUID(),
					snapshot: {
						name: 'Loop B daily',
						type: 'cron',
						config: { expression: '0 10 * * *' },
						actionPrompt: 'Run B.',
						target_actor_id: sharedSourceActorId,
						enabled: true,
					},
				},
			],
		})
		const app = makeApp(actorId)

		await install(app, loopA.id, workspaceId)
		await install(app, loopB.id, workspaceId)

		const [sharedActor] = await countActorsFromSourceItem(workspaceId, sharedSourceActorId)
		if (!sharedActor) throw new Error('expected the shared actor row')
		const sharedActorId = sharedActor.id

		const [loopAInstall] = await db
			.select({ id: installedLoops.id })
			.from(installedLoops)
			.where(eq(installedLoops.sourceLoopId, loopA.id))
		const [loopBInstall] = await db
			.select({ id: installedLoops.id })
			.from(installedLoops)
			.where(eq(installedLoops.sourceLoopId, loopB.id))
		if (!loopAInstall || !loopBInstall) throw new Error('expected both install rows')

		// Full uninstall of A — the loop that first provisioned the shared agent.
		const uninstallRes = await app.request(
			jsonRequest('DELETE', `/api/installed-loops/${loopAInstall.id}`, {
				keepProvisionedItems: false,
			}),
		)
		expect(uninstallRes.status).toBe(200)
		const uninstallBody = (await uninstallRes.json()) as { removedElements: { actors: number } }
		expect(uninstallBody.removedElements.actors).toBe(0)

		// The shared agent survives and is still a workspace member.
		const [survivor] = await countActorsFromSourceItem(workspaceId, sharedSourceActorId)
		expect(survivor?.id).toBe(sharedActorId)

		// Ownership marker moved to loop B, so the agent retires with B's uninstall.
		const [rehomedMeta] = await db
			.select({ installedLoopId: sql<string>`${actors.metadata}->>'installed_loop_id'` })
			.from(actors)
			.where(eq(actors.id, sharedActorId))
		expect(rehomedMeta?.installedLoopId).toBe(loopBInstall.id)

		// A's trigger is gone; B's survives and still targets the shared agent.
		const triggersAfter = await db
			.select({
				targetActorId: triggers.targetActorId,
				installedLoopId: sql<string>`${triggers.metadata}->>'installed_loop_id'`,
			})
			.from(triggers)
			.where(eq(triggers.workspaceId, workspaceId))
		expect(triggersAfter).toHaveLength(1)
		expect(triggersAfter[0]?.installedLoopId).toBe(loopBInstall.id)
		expect(triggersAfter[0]?.targetActorId).toBe(sharedActorId)

		// Uninstalling B too finally retires the agent.
		const secondRes = await app.request(
			jsonRequest('DELETE', `/api/installed-loops/${loopBInstall.id}`, {
				keepProvisionedItems: false,
			}),
		)
		expect(secondRes.status).toBe(200)
		const secondBody = (await secondRes.json()) as { removedElements: { actors: number } }
		expect(secondBody.removedElements.actors).toBe(1)
		const after = await countActorsFromSourceItem(workspaceId, sharedSourceActorId)
		expect(after).toHaveLength(0)
	})

	it("publishing a loop version that drops a shared agent keeps the agent and the surviving loop's trigger", async () => {
		const sharedSourceActorId = randomUUID()
		const loopA = await seedMarketplaceLoop({
			name: 'Loop A',
			version: '1.0.0',
			actorItems: [{ sourceItemId: sharedSourceActorId, snapshot: AGENT_SNAPSHOT }],
			triggerItems: [
				{
					sourceItemId: randomUUID(),
					snapshot: {
						name: 'Loop A daily',
						type: 'cron',
						config: { expression: '0 9 * * *' },
						actionPrompt: 'Run A.',
						target_actor_id: sharedSourceActorId,
						enabled: true,
					},
				},
			],
		})
		const loopB = await seedMarketplaceLoop({
			name: 'Loop B',
			actorItems: [{ sourceItemId: sharedSourceActorId, snapshot: AGENT_SNAPSHOT }],
			triggerItems: [
				{
					sourceItemId: randomUUID(),
					snapshot: {
						name: 'Loop B daily',
						type: 'cron',
						config: { expression: '0 10 * * *' },
						actionPrompt: 'Run B.',
						target_actor_id: sharedSourceActorId,
						enabled: true,
					},
				},
			],
		})
		const app = makeApp(actorId)

		await install(app, loopA.id, workspaceId)
		await install(app, loopB.id, workspaceId)

		const [sharedActor] = await countActorsFromSourceItem(workspaceId, sharedSourceActorId)
		if (!sharedActor) throw new Error('expected the shared actor row')
		const sharedActorId = sharedActor.id

		const [loopAInstall] = await db
			.select({ id: installedLoops.id })
			.from(installedLoops)
			.where(eq(installedLoops.sourceLoopId, loopA.id))
		const [loopBInstall] = await db
			.select({ id: installedLoops.id })
			.from(installedLoops)
			.where(eq(installedLoops.sourceLoopId, loopB.id))
		if (!loopAInstall || !loopBInstall) throw new Error('expected both install rows')

		// Publish Loop A v2 that drops the shared agent and A's trigger.
		const loopAid = loopA.id
		await db.delete(marketplaceLoopItems).where(eq(marketplaceLoopItems.loopId, loopAid))
		await db
			.update(marketplaceLoops)
			.set({ version: '2.0.0' })
			.where(eq(marketplaceLoops.id, loopAid))

		const pusher = new LoopVersionPusher(
			db,
			new AgentStorageManager(createMemoryStorage(), db),
			60_000,
		)
		await pusher.tick()

		// The shared agent survives the version drop, rehomed under loop B.
		const [survivor] = await countActorsFromSourceItem(workspaceId, sharedSourceActorId)
		expect(survivor?.id).toBe(sharedActorId)
		const [rehomedMeta] = await db
			.select({ installedLoopId: sql<string>`${actors.metadata}->>'installed_loop_id'` })
			.from(actors)
			.where(eq(actors.id, sharedActorId))
		expect(rehomedMeta?.installedLoopId).toBe(loopBInstall.id)

		// A's trigger is gone; B's still fires at the shared agent.
		const triggersAfter = await db
			.select({
				targetActorId: triggers.targetActorId,
				installedLoopId: sql<string>`${triggers.metadata}->>'installed_loop_id'`,
			})
			.from(triggers)
			.where(eq(triggers.workspaceId, workspaceId))
		expect(triggersAfter).toHaveLength(1)
		expect(triggersAfter[0]?.installedLoopId).toBe(loopBInstall.id)
		expect(triggersAfter[0]?.targetActorId).toBe(sharedActorId)

		// And loop A's install advanced to v2.
		const [row] = await db
			.select({ installedVersion: installedLoops.installedVersion })
			.from(installedLoops)
			.where(eq(installedLoops.sourceLoopId, loopAid))
		expect(row?.installedVersion).toBe('2.0.0')
	})
})
