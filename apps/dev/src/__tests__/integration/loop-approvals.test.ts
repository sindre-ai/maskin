import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, loopOutputApprovals } from '@maskin/db/schema'
import { and, desc, eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

// Load the routes lazily so vitest doesn't pull them in at module resolution
// time (same pattern used across the loops integration test).
const { default: loopApprovalsRoutes } = await import('../../routes/loop-approvals')
const { default: loopsRoutes } = await import('../../routes/loops')

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
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
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		await next()
	})
	app.route('/api/loop-approvals', loopApprovalsRoutes)
	app.route('/api/loops', loopsRoutes)
	return app
}

describe('Loop output approvals integration', () => {
	let workspaceId: string
	let actorId: string
	let loopId: string
	let driverActorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		const loop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'supervised',
			title: 'Weekly summary',
		})
		loopId = loop.id
		const driver = await insertActor(db, { type: 'agent', name: 'Summary Agent' })
		driverActorId = driver.id
	})

	it('enqueues a pending approval and audits the create event', async () => {
		const app = makeApp(actorId)
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/loop-approvals',
				{
					loop_id: loopId,
					driver_actor_id: driverActorId,
					payload: { subject: 'Draft', body: 'Hello world' },
				},
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(201)
		const body = (await res.json()) as {
			id: string
			status: string
			loopId: string
			payload: Record<string, unknown>
		}
		expect(body.status).toBe('pending')
		expect(body.loopId).toBe(loopId)
		expect(body.payload).toEqual({ subject: 'Draft', body: 'Hello world' })

		const [row] = await db
			.select()
			.from(loopOutputApprovals)
			.where(eq(loopOutputApprovals.id, body.id))
		expect(row.status).toBe('pending')
		expect(row.workspaceId).toBe(workspaceId)
		expect(row.driverActorId).toBe(driverActorId)

		const eventRows = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, body.id), eq(events.action, 'created')))
		expect(eventRows.length).toBe(1)
		expect(eventRows[0].entityType).toBe('loop_output_approval')
	})

	it('rejects an enqueue when the loop id is not a loop in the workspace', async () => {
		const foreignActor = await insertActor(db)
		const foreignWs = await insertWorkspace(db, foreignActor.id)
		const foreignLoop = await insertObject(db, foreignWs.id, foreignActor.id, {
			type: 'loop',
			status: 'supervised',
			title: 'Foreign loop',
		})
		const app = makeApp(actorId)
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/loop-approvals',
				{ loop_id: foreignLoop.id, payload: { hi: 'there' } },
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(404)
	})

	it('approve fans out loop_output_delivered with the original payload when no edit', async () => {
		const app = makeApp(actorId)
		const created = await app
			.request(
				jsonRequest(
					'POST',
					'/api/loop-approvals',
					{
						loop_id: loopId,
						driver_actor_id: driverActorId,
						payload: { subject: 'Original' },
					},
					{ 'x-workspace-id': workspaceId },
				),
			)
			.then((r) => r.json() as unknown as { id: string })

		const approve = await app.request(
			jsonRequest(
				'POST',
				`/api/loop-approvals/${created.id}/approve`,
				{},
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(approve.status).toBe(200)
		const body = (await approve.json()) as {
			status: string
			editedPayload: Record<string, unknown> | null
			correctionNote: string | null
			decidedBy: string
			decidedAt: string
		}
		expect(body.status).toBe('approved')
		expect(body.editedPayload).toBeNull()
		expect(body.correctionNote).toBeNull()
		expect(body.decidedBy).toBe(actorId)
		expect(body.decidedAt).not.toBeNull()

		const delivered = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, created.id), eq(events.action, 'loop_output_delivered')))
		expect(delivered.length).toBe(1)
		expect(
			(delivered[0].data as { delivered_payload: Record<string, unknown> }).delivered_payload,
		).toEqual({ subject: 'Original' })
		expect((delivered[0].data as { was_edited: boolean }).was_edited).toBe(false)

		// No correction event should exist on a straight approve.
		const corrections = await db
			.select()
			.from(events)
			.where(eq(events.action, 'loop_output_corrected'))
		expect(corrections.length).toBe(0)
	})

	it('approve with edited_payload fans out both delivered (with edit) and corrected (routed at driver)', async () => {
		const app = makeApp(actorId)
		const created = await app
			.request(
				jsonRequest(
					'POST',
					'/api/loop-approvals',
					{
						loop_id: loopId,
						driver_actor_id: driverActorId,
						payload: { subject: 'Original', tone: 'formal' },
					},
					{ 'x-workspace-id': workspaceId },
				),
			)
			.then((r) => r.json() as unknown as { id: string })

		const approve = await app.request(
			jsonRequest(
				'POST',
				`/api/loop-approvals/${created.id}/approve`,
				{
					edited_payload: { subject: 'Edited', tone: 'warm' },
					correction_note: 'Match brand tone',
				},
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(approve.status).toBe(200)
		const body = (await approve.json()) as {
			status: string
			editedPayload: Record<string, unknown>
			correctionNote: string
		}
		expect(body.status).toBe('approved')
		expect(body.editedPayload).toEqual({ subject: 'Edited', tone: 'warm' })
		expect(body.correctionNote).toBe('Match brand tone')

		const delivered = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, created.id), eq(events.action, 'loop_output_delivered')))
		expect(delivered.length).toBe(1)
		expect(
			(delivered[0].data as { delivered_payload: Record<string, unknown> }).delivered_payload,
		).toEqual({ subject: 'Edited', tone: 'warm' })
		expect((delivered[0].data as { was_edited: boolean }).was_edited).toBe(true)

		// The training signal — routed at the driver actor, not the approval row.
		const corrections = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, driverActorId), eq(events.action, 'loop_output_corrected')))
		expect(corrections.length).toBe(1)
		const data = corrections[0].data as {
			approval_id: string
			original_payload: Record<string, unknown>
			edited_payload: Record<string, unknown>
			correction_note: string
		}
		expect(data.approval_id).toBe(created.id)
		expect(data.original_payload).toEqual({ subject: 'Original', tone: 'formal' })
		expect(data.edited_payload).toEqual({ subject: 'Edited', tone: 'warm' })
		expect(data.correction_note).toBe('Match brand tone')
	})

	it('reject discards and fans out loop_output_rejected against the driver actor', async () => {
		const app = makeApp(actorId)
		const created = await app
			.request(
				jsonRequest(
					'POST',
					'/api/loop-approvals',
					{
						loop_id: loopId,
						driver_actor_id: driverActorId,
						payload: { subject: 'Bad draft' },
					},
					{ 'x-workspace-id': workspaceId },
				),
			)
			.then((r) => r.json() as unknown as { id: string })

		const reject = await app.request(
			jsonRequest(
				'POST',
				`/api/loop-approvals/${created.id}/reject`,
				{ reason: 'Off-topic — try again' },
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(reject.status).toBe(200)
		const body = (await reject.json()) as {
			status: string
			correctionNote: string
			decidedBy: string
		}
		expect(body.status).toBe('rejected')
		expect(body.correctionNote).toBe('Off-topic — try again')
		expect(body.decidedBy).toBe(actorId)

		// No delivery event on reject.
		const delivered = await db
			.select()
			.from(events)
			.where(eq(events.action, 'loop_output_delivered'))
		expect(delivered.length).toBe(0)

		const rejected = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, driverActorId), eq(events.action, 'loop_output_rejected')))
		expect(rejected.length).toBe(1)
		expect((rejected[0].data as { reason: string }).reason).toBe('Off-topic — try again')
	})

	it('one-way state: a second decide 409s so the queue reader cannot double-fire delivery', async () => {
		const app = makeApp(actorId)
		const created = await app
			.request(
				jsonRequest(
					'POST',
					'/api/loop-approvals',
					{ loop_id: loopId, payload: { hi: 'first' } },
					{ 'x-workspace-id': workspaceId },
				),
			)
			.then((r) => r.json() as unknown as { id: string })

		const first = await app.request(
			jsonRequest(
				'POST',
				`/api/loop-approvals/${created.id}/approve`,
				{},
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(first.status).toBe(200)

		const second = await app.request(
			jsonRequest(
				'POST',
				`/api/loop-approvals/${created.id}/approve`,
				{},
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(second.status).toBe(409)

		const rejectAfter = await app.request(
			jsonRequest(
				'POST',
				`/api/loop-approvals/${created.id}/reject`,
				{},
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(rejectAfter.status).toBe(409)

		// Delivery event must have fired exactly once regardless of the retries.
		const delivered = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, created.id), eq(events.action, 'loop_output_delivered')))
		expect(delivered.length).toBe(1)
	})

	it('list filters by workspace + optional loop + optional status, newest first', async () => {
		const otherLoop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'supervised',
			title: 'Second loop',
		})
		const app = makeApp(actorId)
		const first = await app
			.request(
				jsonRequest(
					'POST',
					'/api/loop-approvals',
					{ loop_id: loopId, payload: { n: 1 } },
					{ 'x-workspace-id': workspaceId },
				),
			)
			.then((r) => r.json() as unknown as { id: string })
		// Bump the timestamp so ordering is deterministic across the two rows.
		await db
			.update(loopOutputApprovals)
			.set({ createdAt: new Date('2026-08-01T00:00:00Z') })
			.where(eq(loopOutputApprovals.id, first.id))

		const second = await app
			.request(
				jsonRequest(
					'POST',
					'/api/loop-approvals',
					{ loop_id: otherLoop.id, payload: { n: 2 } },
					{ 'x-workspace-id': workspaceId },
				),
			)
			.then((r) => r.json() as unknown as { id: string })
		await db
			.update(loopOutputApprovals)
			.set({ createdAt: new Date('2026-08-15T00:00:00Z') })
			.where(eq(loopOutputApprovals.id, second.id))

		// Sanity check ordering directly in the DB before the API call so a wrong
		// list result surfaces as a route bug, not a fixture flake.
		const raw = await db
			.select({ id: loopOutputApprovals.id })
			.from(loopOutputApprovals)
			.where(eq(loopOutputApprovals.workspaceId, workspaceId))
			.orderBy(desc(loopOutputApprovals.createdAt))
		expect(raw.map((r) => r.id)).toEqual([second.id, first.id])

		const all = await app.request(jsonGet('/api/loop-approvals', { 'x-workspace-id': workspaceId }))
		const allBody = (await all.json()) as Array<{ id: string; loopId: string }>
		expect(allBody.map((r) => r.id)).toEqual([second.id, first.id])

		const filtered = await app.request(
			jsonGet(`/api/loop-approvals?loop_id=${loopId}`, {
				'x-workspace-id': workspaceId,
			}),
		)
		const filteredBody = (await filtered.json()) as Array<{ id: string; loopId: string }>
		expect(filteredBody).toHaveLength(1)
		expect(filteredBody[0].id).toBe(first.id)
	})

	it('pendingApprovalCount on GET /api/loops counts pending only, per loop', async () => {
		const otherLoop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'supervised',
			title: 'Second loop',
		})
		const app = makeApp(actorId)

		// loopId gets two pending + one approved.
		for (let i = 0; i < 3; i++) {
			const row = await app
				.request(
					jsonRequest(
						'POST',
						'/api/loop-approvals',
						{ loop_id: loopId, payload: { n: i } },
						{ 'x-workspace-id': workspaceId },
					),
				)
				.then((r) => r.json() as unknown as { id: string })
			if (i === 0) {
				await app.request(
					jsonRequest(
						'POST',
						`/api/loop-approvals/${row.id}/approve`,
						{},
						{ 'x-workspace-id': workspaceId },
					),
				)
			}
		}

		// otherLoop gets one pending.
		await app.request(
			jsonRequest(
				'POST',
				'/api/loop-approvals',
				{ loop_id: otherLoop.id, payload: {} },
				{ 'x-workspace-id': workspaceId },
			),
		)

		const listRes = await app.request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		expect(listRes.status).toBe(200)
		const listBody = (await listRes.json()) as {
			loops: Array<{ id: string; pendingApprovalCount: number }>
		}
		const byId = new Map(listBody.loops.map((l) => [l.id, l.pendingApprovalCount]))
		expect(byId.get(loopId)).toBe(2)
		expect(byId.get(otherLoop.id)).toBe(1)
	})

	it('CHECK constraint blocks unknown status values from being written directly', async () => {
		await expect(
			db
				.insert(loopOutputApprovals)
				.values({
					workspaceId,
					loopId,
					status: 'garbage',
					payload: {},
				})
				.returning(),
		).rejects.toThrow()
	})

	it('ON DELETE CASCADE from the loop object clears its pending queue', async () => {
		const app = makeApp(actorId)
		await app.request(
			jsonRequest(
				'POST',
				'/api/loop-approvals',
				{ loop_id: loopId, payload: { hi: 'there' } },
				{ 'x-workspace-id': workspaceId },
			),
		)
		await db.delete(events).where(eq(events.entityId, loopId))
		// Delete the loop object; the FK is ON DELETE CASCADE so its approvals go too.
		await db.execute(sql`DELETE FROM objects WHERE id = ${loopId}`)
		const remaining = await db
			.select()
			.from(loopOutputApprovals)
			.where(eq(loopOutputApprovals.loopId, loopId))
		expect(remaining).toEqual([])
	})
})
