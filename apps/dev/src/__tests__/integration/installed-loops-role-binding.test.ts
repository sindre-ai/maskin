import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	actors,
	agentSkills,
	marketplaceLoops,
	objects,
	triggers,
	workspaceMembers,
	workspaceSkills,
} from '@maskin/db/schema'
import { WORKSPACE_IMPROVEMENTS_LOOP_SLUG, readLoopViews } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, inArray } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { seedMarketplaceLoops } from '../../lib/dev-bootstrap'
import { createApiError, formatZodError } from '../../lib/errors'
import { AgentStorageManager } from '../../services/agent-storage'
import { bootstrapDefaultAgents, seedDefaultAgentActors } from '../../services/workspace-bootstrap'
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

// The Workspace improvements flow ships no agents. Its triggers and skills name the Workspace Coach
// and the Chief of Staff by role, and install binds them to the workspace's own agents. An existing
// hand-made flow of the same name is adopted, never duplicated.
describe('Marketplace install — Workspace improvements binds to the workspace agents', () => {
	let loopId: string

	beforeAll(async () => {
		await rawSql`TRUNCATE marketplace_loops, marketplace_loop_items CASCADE`
		await seedMarketplaceLoops(db)
		const [loop] = await db
			.select({ id: marketplaceLoops.id })
			.from(marketplaceLoops)
			.where(eq(marketplaceLoops.slug, WORKSPACE_IMPROVEMENTS_LOOP_SLUG))
		if (!loop) throw new Error('expected the Workspace improvements marketplace loop')
		loopId = loop.id
	})

	beforeEach(async () => {
		await rawSql`TRUNCATE installed_loops CASCADE`
	})

	async function workspaceWithAgents(withCoach: boolean) {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		if (!ws) throw new Error('workspace insert returned no row')
		const agentStorage = new AgentStorageManager(createMemoryStorage(), db)
		// The real path seeds the Coach and the Chief of Staff together; the Coach is left out for the
		// "no Coach" case, where bootstrapDefaultAgents still seeds the Chief of Staff.
		if (withCoach) await db.transaction((tx) => seedDefaultAgentActors(tx, ws.id, actorId))
		await bootstrapDefaultAgents(db, agentStorage, ws.id, actorId)
		return { ws, actorId }
	}

	async function agentIdByName(workspaceId: string, name: string) {
		const rows = await db
			.select({ id: actors.id })
			.from(workspaceMembers)
			.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
			.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.name, name)))
		expect(rows).toHaveLength(1)
		return rows[0]?.id as string
	}

	async function memberCount(workspaceId: string) {
		const rows = await db
			.select({ id: workspaceMembers.actorId })
			.from(workspaceMembers)
			.where(eq(workspaceMembers.workspaceId, workspaceId))
		return rows.length
	}

	async function install(actorId: string, workspaceId: string) {
		const res = await makeApp(actorId).request(
			jsonRequest('POST', '/api/installed-loops', { loopId, workspaceId }),
		)
		if (res.status !== 201) throw new Error(`install returned ${res.status}: ${await res.text()}`)
		return (await res.json()) as { id: string; objectId: string }
	}

	it('runs both triggers on the existing agents, adds no agent and leaves their prompts alone', async () => {
		const { ws, actorId } = await workspaceWithAgents(true)
		const coachId = await agentIdByName(ws.id, 'Workspace Coach')
		const chiefId = await agentIdByName(ws.id, 'Chief of Staff')
		const before = await db
			.select({ id: actors.id, systemPrompt: actors.systemPrompt })
			.from(actors)
			.where(inArray(actors.id, [coachId, chiefId]))
		const members = await memberCount(ws.id)

		const body = await install(actorId, ws.id)

		expect(await memberCount(ws.id)).toBe(members)
		const after = await db
			.select({ id: actors.id, systemPrompt: actors.systemPrompt })
			.from(actors)
			.where(inArray(actors.id, [coachId, chiefId]))
		expect(new Map(after.map((a) => [a.id, a.systemPrompt]))).toEqual(
			new Map(before.map((a) => [a.id, a.systemPrompt])),
		)

		const rows = await db
			.select({
				name: triggers.name,
				targetActorId: triggers.targetActorId,
				enabled: triggers.enabled,
			})
			.from(triggers)
			.where(eq(triggers.workspaceId, ws.id))
		const installed = rows.filter(
			(r) => r.name.startsWith('Coach sweep') || r.name.startsWith('Owner heartbeat'),
		)
		expect(installed).toEqual(
			expect.arrayContaining([
				{ name: 'Coach sweep (Mon, Wed, Fri 23:15 UTC)', targetActorId: coachId, enabled: true },
				{ name: 'Owner heartbeat (daily 08:10 UTC)', targetActorId: chiefId, enabled: true },
			]),
		)
		expect(installed).toHaveLength(2)

		// Both skills sit on the Chief of Staff, which drives the flow.
		const skills = await db
			.select({ name: workspaceSkills.name })
			.from(agentSkills)
			.innerJoin(workspaceSkills, eq(agentSkills.workspaceSkillId, workspaceSkills.id))
			.where(eq(agentSkills.actorId, chiefId))
		expect(skills.map((s) => s.name)).toEqual(
			expect.arrayContaining(['drive-to-outcome', 'results-view-refresh']),
		)

		// The checklist tasks are driven by the Chief of Staff.
		const tasks = await db
			.select({ driver: objects.driver })
			.from(objects)
			.where(and(eq(objects.workspaceId, ws.id), eq(objects.type, 'task')))
		expect(tasks.length).toBeGreaterThan(1)
		for (const task of tasks) expect(task.driver).toBe(chiefId)
		expect(body.objectId).toBeTruthy()
	})

	it('installs without the Coach trigger when the workspace has no Coach', async () => {
		const { ws, actorId } = await workspaceWithAgents(false)
		await install(actorId, ws.id)

		const rows = await db
			.select({ name: triggers.name })
			.from(triggers)
			.where(eq(triggers.workspaceId, ws.id))
		const names = rows.map((r) => r.name)
		expect(names).toContain('Owner heartbeat (daily 08:10 UTC)')
		expect(names).not.toContain('Coach sweep (Mon, Wed, Fri 23:15 UTC)')
	})

	it('adopts the hand-made flow of the same name, switches its old triggers off and creates no second flow', async () => {
		const { ws, actorId } = await workspaceWithAgents(true)
		const coachId = await agentIdByName(ws.id, 'Workspace Coach')

		const [oldTrigger] = await db
			.insert(triggers)
			.values({
				workspaceId: ws.id,
				name: 'Workspace Coach — daily sweep',
				type: 'cron',
				config: { expression: '0 9 * * *' },
				actionPrompt: 'Sweep.',
				targetActorId: coachId,
				enabled: true,
				createdBy: actorId,
			})
			.returning({ id: triggers.id })
		const [handMade] = await db
			.insert(objects)
			.values({
				workspaceId: ws.id,
				type: 'loop',
				title: 'Workspace improvements',
				content: 'Hand-made copy with its own words.',
				status: 'live',
				createdBy: actorId,
				metadata: {
					entry_condition: 'Our own entry condition.',
					trigger_ids: [oldTrigger?.id],
				},
			})
			.returning({ id: objects.id })
		if (!handMade || !oldTrigger) throw new Error('hand-made flow insert returned no row')

		const body = await install(actorId, ws.id)

		// The install is linked to the hand-made flow, not a new one.
		expect(body.objectId).toBe(handMade.id)
		const flows = await db
			.select({
				id: objects.id,
				content: objects.content,
				status: objects.status,
				metadata: objects.metadata,
			})
			.from(objects)
			.where(
				and(
					eq(objects.workspaceId, ws.id),
					eq(objects.type, 'loop'),
					eq(objects.title, 'Workspace improvements'),
				),
			)
		expect(flows).toHaveLength(1)
		expect(flows[0]?.content).toBe('Hand-made copy with its own words.')
		expect(flows[0]?.status).toBe('live')
		const meta = flows[0]?.metadata as {
			installed_from_marketplace_loop_id?: string
			entry_condition?: string
			close_condition?: string
			trigger_ids?: string[]
			replaced_trigger_ids?: string[]
		}
		expect(meta.installed_from_marketplace_loop_id).toBe(loopId)
		// Its own words win, the shipped text only fills what it lacked.
		expect(meta.entry_condition).toBe('Our own entry condition.')
		expect(meta.close_condition).toBeTruthy()
		expect(meta.replaced_trigger_ids).toEqual([oldTrigger.id])
		expect(meta.trigger_ids).toHaveLength(2)
		expect(meta.trigger_ids).not.toContain(oldTrigger.id)

		// Only the install's triggers run: the old one is off, the new two are on.
		const rows = await db
			.select({ id: triggers.id, enabled: triggers.enabled })
			.from(triggers)
			.where(eq(triggers.workspaceId, ws.id))
		const enabledIds = rows.filter((r) => r.enabled).map((r) => r.id)
		expect(enabledIds).not.toContain(oldTrigger.id)
		for (const id of meta.trigger_ids ?? []) expect(enabledIds).toContain(id)

		// An adopted flow is already running: no first-day checklist, and the shipped Results tab is
		// still added because the hand-made flow had no tab of that name.
		const tasks = await db
			.select({ id: objects.id })
			.from(objects)
			.where(and(eq(objects.workspaceId, ws.id), eq(objects.type, 'task')))
		expect(tasks).toHaveLength(0)
		expect(readLoopViews(flows[0]?.metadata as Record<string, unknown>).map((v) => v.name)).toEqual(
			['Results'],
		)
	})

	it('does not adopt a flow that is already linked to a marketplace flow', async () => {
		const { ws, actorId } = await workspaceWithAgents(true)
		const [linked] = await db
			.insert(objects)
			.values({
				workspaceId: ws.id,
				type: 'loop',
				title: 'Workspace improvements',
				content: 'Linked elsewhere.',
				status: 'pilot',
				createdBy: actorId,
				metadata: { installed_from_marketplace_loop_id: '00000000-0000-4000-8000-000000000001' },
			})
			.returning({ id: objects.id })

		const body = await install(actorId, ws.id)
		expect(body.objectId).not.toBe(linked?.id)
	})
})
