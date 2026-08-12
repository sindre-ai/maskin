import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	installedLoops,
	marketplaceLoopItems,
	marketplaceLoops,
	workspaceSkills,
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

type SkillItem = { sourceItemId: string; snapshot: Record<string, unknown> }

async function seedMarketplaceLoop(opts: {
	name: string
	version?: string
	skillItems: SkillItem[]
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

	await db.insert(marketplaceLoopItems).values(
		opts.skillItems.map((s) => ({
			loopId: loop.id,
			itemType: 'skill' as const,
			sourceItemId: s.sourceItemId,
			itemSnapshot: s.snapshot,
		})),
	)
	return loop
}

async function countSkillsFromSourceItem(workspaceId: string, sourceItemId: string) {
	return db
		.select({ id: workspaceSkills.id })
		.from(workspaceSkills)
		.where(
			and(
				eq(workspaceSkills.workspaceId, workspaceId),
				sql`${workspaceSkills.metadata}->>'source_item_id' = ${sourceItemId}`,
			),
		)
}

async function install(app: ReturnType<typeof makeApp>, loopId: string, workspaceId: string) {
	const res = await app.request(
		jsonRequest('POST', '/api/installed-loops', { loopId, workspaceId }),
	)
	return { status: res.status, body: (await res.json()) as { provisioned: { skills: number } } }
}

const SKILL_SNAPSHOT = {
	name: 'consult-knowledge',
	description: 'Bundled in more than one loop',
	content: '---\nname: consult-knowledge\n---\n\nDo the thing.',
	isValid: true,
} as const

describe('Loop install skill dedup guard', () => {
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

	it('two loops that bundle the same skill leave exactly one row instead of colliding on the name unique index', async () => {
		const sharedSourceSkillId = randomUUID()
		const loopA = await seedMarketplaceLoop({
			name: 'Loop A',
			skillItems: [{ sourceItemId: sharedSourceSkillId, snapshot: SKILL_SNAPSHOT }],
		})
		const loopB = await seedMarketplaceLoop({
			name: 'Loop B',
			skillItems: [{ sourceItemId: sharedSourceSkillId, snapshot: SKILL_SNAPSHOT }],
		})
		const app = makeApp(actorId)

		const first = await install(app, loopA.id, workspaceId)
		expect(first.status).toBe(201)
		expect(first.body.provisioned.skills).toBe(1)

		// Second loop bundles the SAME skill — it must reuse, not clone (and must
		// not 500 on the workspace_skills (workspace_id, name) unique index).
		const second = await install(app, loopB.id, workspaceId)
		expect(second.status).toBe(201)
		expect(second.body.provisioned.skills).toBe(0)

		const copies = await countSkillsFromSourceItem(workspaceId, sharedSourceSkillId)
		expect(copies).toHaveLength(1)
	})

	it('fully uninstalling the loop that first provisioned a shared skill keeps the skill for the surviving loop', async () => {
		const sharedSourceSkillId = randomUUID()
		const loopA = await seedMarketplaceLoop({
			name: 'Loop A',
			skillItems: [{ sourceItemId: sharedSourceSkillId, snapshot: SKILL_SNAPSHOT }],
		})
		const loopB = await seedMarketplaceLoop({
			name: 'Loop B',
			skillItems: [{ sourceItemId: sharedSourceSkillId, snapshot: SKILL_SNAPSHOT }],
		})
		const app = makeApp(actorId)

		await install(app, loopA.id, workspaceId)
		await install(app, loopB.id, workspaceId)

		const [sharedSkill] = await countSkillsFromSourceItem(workspaceId, sharedSourceSkillId)
		if (!sharedSkill) throw new Error('expected the shared skill row')

		const [loopAInstall] = await db
			.select({ id: installedLoops.id })
			.from(installedLoops)
			.where(eq(installedLoops.sourceLoopId, loopA.id))
		const [loopBInstall] = await db
			.select({ id: installedLoops.id })
			.from(installedLoops)
			.where(eq(installedLoops.sourceLoopId, loopB.id))
		if (!loopAInstall || !loopBInstall) throw new Error('expected both install rows')

		// Full uninstall of A — the loop that first provisioned the shared skill.
		const uninstallRes = await app.request(
			jsonRequest('DELETE', `/api/installed-loops/${loopAInstall.id}`, {
				keepProvisionedItems: false,
			}),
		)
		expect(uninstallRes.status).toBe(200)
		const uninstallBody = (await uninstallRes.json()) as { removedElements: { skills: number } }
		expect(uninstallBody.removedElements.skills).toBe(0)

		// The shared skill survives, rehomed under loop B.
		const [survivor] = await countSkillsFromSourceItem(workspaceId, sharedSourceSkillId)
		expect(survivor?.id).toBe(sharedSkill.id)
		const [rehomedMeta] = await db
			.select({ installedLoopId: sql<string>`${workspaceSkills.metadata}->>'installed_loop_id'` })
			.from(workspaceSkills)
			.where(eq(workspaceSkills.id, sharedSkill.id))
		expect(rehomedMeta?.installedLoopId).toBe(loopBInstall.id)

		// Uninstalling B too finally retires the skill.
		const secondRes = await app.request(
			jsonRequest('DELETE', `/api/installed-loops/${loopBInstall.id}`, {
				keepProvisionedItems: false,
			}),
		)
		expect(secondRes.status).toBe(200)
		const secondBody = (await secondRes.json()) as { removedElements: { skills: number } }
		expect(secondBody.removedElements.skills).toBe(1)
		const after = await countSkillsFromSourceItem(workspaceId, sharedSourceSkillId)
		expect(after).toHaveLength(0)
	})

	it('the version-push cron reuses a skill another loop already provisioned instead of cloning it, and counts it as a reuse', async () => {
		const sharedSourceSkillId = randomUUID()
		// Loop A's own skill is unrelated (different source item AND different
		// name) — this test is isolated to the source-item reuse pathway, not the
		// name-collision pathway covered separately below.
		const loopA = await seedMarketplaceLoop({
			name: 'Loop A',
			version: '1.0.0',
			skillItems: [
				{
					sourceItemId: randomUUID(),
					snapshot: { ...SKILL_SNAPSHOT, name: 'loop-a-own-skill' },
				},
			],
		})
		const loopB = await seedMarketplaceLoop({
			name: 'Loop B',
			skillItems: [{ sourceItemId: sharedSourceSkillId, snapshot: SKILL_SNAPSHOT }],
		})
		const app = makeApp(actorId)

		await install(app, loopA.id, workspaceId)
		await install(app, loopB.id, workspaceId)
		const before = await countSkillsFromSourceItem(workspaceId, sharedSourceSkillId)
		expect(before).toHaveLength(1)

		// Publish Loop A v2 that now includes the shared skill as a new item.
		await db
			.update(marketplaceLoops)
			.set({ version: '2.0.0' })
			.where(eq(marketplaceLoops.id, loopA.id))
		await db.insert(marketplaceLoopItems).values({
			loopId: loopA.id,
			itemType: 'skill',
			sourceItemId: sharedSourceSkillId,
			itemSnapshot: SKILL_SNAPSHOT,
		})

		const pusher = new LoopVersionPusher(
			db,
			new AgentStorageManager(createMemoryStorage(), db),
			60_000,
		)
		await pusher.tick()

		const after = await countSkillsFromSourceItem(workspaceId, sharedSourceSkillId)
		expect(after).toHaveLength(1)
		expect(after[0]?.id).toBe(before[0]?.id)

		const [installRow] = await db
			.select({ id: installedLoops.id })
			.from(installedLoops)
			.where(eq(installedLoops.sourceLoopId, loopA.id))
		if (!installRow) throw new Error('install row not found')
		const [pushEvent] = await db
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
		expect(pushEvent?.data).toMatchObject({
			items: { adds: 0, updates: 0, removes: 0, reuses: 1 },
		})
	})

	it('installing a loop whose skill collides by name only (different, unrelated source item) reuses the existing row instead of refusing the install', async () => {
		// Two independent source items that happen to share a name — the
		// source-item dedup guard can't help here (they're not "the same" shared
		// item by identity), so this exercises the name-based fallback guard.
		const loopA = await seedMarketplaceLoop({
			name: 'Loop A',
			skillItems: [{ sourceItemId: randomUUID(), snapshot: SKILL_SNAPSHOT }],
		})
		const loopB = await seedMarketplaceLoop({
			name: 'Loop B',
			skillItems: [{ sourceItemId: randomUUID(), snapshot: SKILL_SNAPSHOT }],
		})
		const app = makeApp(actorId)

		const first = await install(app, loopA.id, workspaceId)
		expect(first.status).toBe(201)
		expect(first.body.provisioned.skills).toBe(1)

		// Second loop's skill has an unrelated source_item_id but the same
		// name — it must reuse the existing row, not clone or refuse.
		const second = await install(app, loopB.id, workspaceId)
		expect(second.status).toBe(201)
		expect(second.body.provisioned.skills).toBe(0)

		const installs = await db
			.select({ id: installedLoops.id })
			.from(installedLoops)
			.where(eq(installedLoops.workspaceId, workspaceId))
		expect(installs).toHaveLength(2)
		const skillRows = await db
			.select({ id: workspaceSkills.id })
			.from(workspaceSkills)
			.where(eq(workspaceSkills.workspaceId, workspaceId))
		expect(skillRows).toHaveLength(1)
	})

	it('fully uninstalling the loop that first provisioned a name-collision skill keeps the skill for the loop that reused it by name', async () => {
		const loopA = await seedMarketplaceLoop({
			name: 'Loop A',
			skillItems: [{ sourceItemId: randomUUID(), snapshot: SKILL_SNAPSHOT }],
		})
		const loopB = await seedMarketplaceLoop({
			name: 'Loop B',
			skillItems: [{ sourceItemId: randomUUID(), snapshot: SKILL_SNAPSHOT }],
		})
		const app = makeApp(actorId)

		await install(app, loopA.id, workspaceId)
		await install(app, loopB.id, workspaceId)

		const [sharedSkill] = await db
			.select({ id: workspaceSkills.id })
			.from(workspaceSkills)
			.where(eq(workspaceSkills.workspaceId, workspaceId))
		if (!sharedSkill) throw new Error('expected the shared skill row')

		const [loopAInstall] = await db
			.select({ id: installedLoops.id })
			.from(installedLoops)
			.where(eq(installedLoops.sourceLoopId, loopA.id))
		const [loopBInstall] = await db
			.select({ id: installedLoops.id })
			.from(installedLoops)
			.where(eq(installedLoops.sourceLoopId, loopB.id))
		if (!loopAInstall || !loopBInstall) throw new Error('expected both install rows')

		// Full uninstall of A — the loop that first provisioned the skill.
		const uninstallRes = await app.request(
			jsonRequest('DELETE', `/api/installed-loops/${loopAInstall.id}`, {
				keepProvisionedItems: false,
			}),
		)
		expect(uninstallRes.status).toBe(200)
		const uninstallBody = (await uninstallRes.json()) as { removedElements: { skills: number } }
		expect(uninstallBody.removedElements.skills).toBe(0)

		// The skill survives, rehomed under loop B, which only ever referenced
		// it by name.
		const [survivor] = await db
			.select({ id: workspaceSkills.id })
			.from(workspaceSkills)
			.where(eq(workspaceSkills.workspaceId, workspaceId))
		expect(survivor?.id).toBe(sharedSkill.id)
		const [rehomedMeta] = await db
			.select({ installedLoopId: sql<string>`${workspaceSkills.metadata}->>'installed_loop_id'` })
			.from(workspaceSkills)
			.where(eq(workspaceSkills.id, sharedSkill.id))
		expect(rehomedMeta?.installedLoopId).toBe(loopBInstall.id)

		// Uninstalling B too finally retires the skill.
		const secondRes = await app.request(
			jsonRequest('DELETE', `/api/installed-loops/${loopBInstall.id}`, {
				keepProvisionedItems: false,
			}),
		)
		expect(secondRes.status).toBe(200)
		const secondBody = (await secondRes.json()) as { removedElements: { skills: number } }
		expect(secondBody.removedElements.skills).toBe(1)
		const after = await db
			.select({ id: workspaceSkills.id })
			.from(workspaceSkills)
			.where(eq(workspaceSkills.workspaceId, workspaceId))
		expect(after).toHaveLength(0)
	})
})
