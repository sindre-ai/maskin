import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { objects, triggers as triggersTable, workspaces } from '@maskin/db/schema'
import { LOOP_STATUSES } from '@maskin/shared'
import { eq, inArray } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertObject, insertTrigger, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: objectsRoutes } = await import('../../routes/objects')

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

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
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		await next()
	})
	app.route('/api/objects', objectsRoutes)
	return app
}

describe('Flow status decides whether the triggers run', () => {
	let workspaceId: string
	let actorId: string
	let agentId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		await db
			.update(workspaces)
			.set({
				settings: {
					...(ws.settings as Record<string, unknown>),
					statuses: {
						...((ws.settings as { statuses?: Record<string, string[]> }).statuses ?? {}),
						loop: [...LOOP_STATUSES],
					},
				},
			})
			.where(eq(workspaces.id, workspaceId))
		const agent = await insertActor(db, { type: 'agent' })
		agentId = agent.id
	})

	async function flowWithTriggers(status: string, enabled: boolean) {
		const a = await insertTrigger(db, workspaceId, actorId, agentId, { enabled })
		const b = await insertTrigger(db, workspaceId, actorId, agentId, { enabled })
		const flow = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status,
			metadata: { trigger_ids: [a.id, b.id] },
		})
		return { flow, triggerIds: [a.id, b.id] }
	}

	async function enabledStates(triggerIds: string[]) {
		const rows = await db
			.select({ enabled: triggersTable.enabled })
			.from(triggersTable)
			.where(inArray(triggersTable.id, triggerIds))
		return rows.map((r) => r.enabled)
	}

	async function setStatus(flowId: string, status: string) {
		const res = await makeApp(actorId).request(
			jsonRequest('PATCH', `/api/objects/${flowId}`, { status }, { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(200)
	}

	it('turns every trigger off when the flow moves to draft', async () => {
		const { flow, triggerIds } = await flowWithTriggers('pilot', true)
		await setStatus(flow.id, 'draft')
		expect(await enabledStates(triggerIds)).toEqual([false, false])
	})

	it('turns every trigger back on when the flow leaves draft', async () => {
		const { flow, triggerIds } = await flowWithTriggers('draft', false)
		await setStatus(flow.id, 'pilot')
		expect(await enabledStates(triggerIds)).toEqual([true, true])
	})

	it('keeps paused working the same way', async () => {
		const { flow, triggerIds } = await flowWithTriggers('live', true)
		await setStatus(flow.id, 'paused')
		expect(await enabledStates(triggerIds)).toEqual([false, false])
		await setStatus(flow.id, 'supervised')
		expect(await enabledStates(triggerIds)).toEqual([true, true])
	})

	it('leaves triggers alone when moving between two off statuses', async () => {
		const { flow, triggerIds } = await flowWithTriggers('draft', false)
		await setStatus(flow.id, 'paused')
		expect(await enabledStates(triggerIds)).toEqual([false, false])
	})

	it('leaves triggers alone when moving between running rungs', async () => {
		const { flow, triggerIds } = await flowWithTriggers('pilot', true)
		const [first] = triggerIds
		await db.update(triggersTable).set({ enabled: false }).where(eq(triggersTable.id, first))
		await setStatus(flow.id, 'supervised')
		await setStatus(flow.id, 'live')
		expect(await enabledStates(triggerIds)).toEqual([false, true])
	})

	it('does not touch the triggers of another workspace', async () => {
		const { flow } = await flowWithTriggers('pilot', true)
		const otherActor = await insertActor(db)
		const otherWs = await insertWorkspace(db, otherActor.id)
		const foreign = await insertTrigger(db, otherWs.id, otherActor.id, agentId, { enabled: true })
		await db
			.update(objects)
			.set({ metadata: { trigger_ids: [foreign.id] } })
			.where(eq(objects.id, flow.id))
		await setStatus(flow.id, 'draft')
		expect(await enabledStates([foreign.id])).toEqual([true])
	})
})
