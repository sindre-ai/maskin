import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, loopOutputApprovals, objects } from '@maskin/db/schema'
import {
	approveLoopApprovalSchema,
	createLoopApprovalSchema,
	listLoopApprovalsQuerySchema,
	loopApprovalResponseSchema,
	rejectLoopApprovalSchema,
} from '@maskin/shared'
import { and, desc, eq } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { errorSchema, idParamSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import { isWorkspaceMember } from '../lib/workspace-auth'

/**
 * Supervised-loop output approval queue (T7 of bet/loop-lifecycle-status-ladder).
 *
 * Callers (task 4's delivery-path wiring) POST here when a `supervised` loop
 * produces output that must not be delivered until a human signs off. This
 * route is deliberately unopinionated about the loop's status — the supervised-
 * gate check lives in the delivery path; enqueueing an approval only requires
 * that the referenced loop exists in the caller's workspace.
 *
 * Approve → `loop_output_delivered` event (plus `loop_output_corrected` when
 * the human edited before approving — that pair is the labelled training
 * signal routed back at the driver agent).
 *
 * Reject → `loop_output_rejected` event routed at the driver agent so it can
 * course-correct on its next run.
 *
 * All state transitions are one-way: pending → approved / rejected. Re-deciding
 * an already-decided row 409s so a queue reader can't accidentally double-fire
 * delivery. The pending-count aggregation the [supervised queue UI](task 8)
 * reads lives on the `GET /api/loops` render shape, computed from this table's
 * (workspace_id, loop_id, status) index — see `apps/dev/src/routes/loops.ts`.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// POST /api/loop-approvals
const createLoopApprovalRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['loop-approvals'],
	summary: 'Enqueue a pending output for a supervised loop',
	description:
		"Creates a `pending` approval row for a loop-produced output. Called by the supervised-delivery path (T4) — this endpoint does not itself check the loop status, only that the loop exists in the caller's workspace. The `payload` is stored verbatim and returned on approve.",
	request: {
		headers: workspaceIdHeader,
		body: {
			content: { 'application/json': { schema: createLoopApprovalSchema } },
		},
	},
	responses: {
		201: {
			description: 'Approval enqueued',
			content: { 'application/json': { schema: loopApprovalResponseSchema } },
		},
		400: {
			description: 'Invalid request',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Loop not found in workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description: 'Internal server error',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(createLoopApprovalRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	const [loop] = await db
		.select({ id: objects.id })
		.from(objects)
		.where(
			and(
				eq(objects.id, body.loop_id),
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'loop'),
			),
		)
		.limit(1)
	if (!loop) {
		return c.json(createApiError('NOT_FOUND', 'Loop not found in workspace'), 404)
	}

	const [created] = await db
		.insert(loopOutputApprovals)
		.values({
			workspaceId,
			loopId: body.loop_id,
			sessionId: body.session_id ?? null,
			driverActorId: body.driver_actor_id ?? null,
			payload: body.payload,
		})
		.returning()
	if (!created) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to enqueue approval'), 500)
	}

	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'created',
		entityType: 'loop_output_approval',
		entityId: created.id,
		data: {
			loop_id: created.loopId,
			session_id: created.sessionId,
			driver_actor_id: created.driverActorId,
			status: created.status,
		},
	})

	return c.json(serialize(created) as z.infer<typeof loopApprovalResponseSchema>, 201)
}) as RouteHandler<typeof createLoopApprovalRoute, Env>)

// GET /api/loop-approvals
const listLoopApprovalsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['loop-approvals'],
	summary: 'List approvals in workspace (filter by loop and/or status)',
	description:
		'Returns approval rows for the workspace, newest first. Defaults to no status filter so callers see the full history; pass `status=pending` for the queue view.',
	request: {
		headers: workspaceIdHeader,
		query: listLoopApprovalsQuerySchema,
	},
	responses: {
		200: {
			description: 'Approvals',
			content: {
				'application/json': { schema: z.array(loopApprovalResponseSchema) },
			},
		},
		400: {
			description: 'Missing workspace ID',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listLoopApprovalsRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { loop_id, status, limit, offset } = c.req.valid('query')

	const conditions = [eq(loopOutputApprovals.workspaceId, workspaceId)]
	if (loop_id) conditions.push(eq(loopOutputApprovals.loopId, loop_id))
	if (status) conditions.push(eq(loopOutputApprovals.status, status))

	const rows = await db
		.select()
		.from(loopOutputApprovals)
		.where(and(...conditions))
		.orderBy(desc(loopOutputApprovals.createdAt))
		.limit(limit)
		.offset(offset)

	return c.json(serializeArray(rows) as z.infer<typeof loopApprovalResponseSchema>[])
}) as RouteHandler<typeof listLoopApprovalsRoute, Env>)

// GET /api/loop-approvals/:id
const getLoopApprovalRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['loop-approvals'],
	summary: 'Fetch a single approval by id',
	request: { params: idParamSchema },
	responses: {
		200: {
			description: 'Approval',
			content: { 'application/json': { schema: loopApprovalResponseSchema } },
		},
		404: {
			description: 'Not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(getLoopApprovalRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	const [row] = await db
		.select()
		.from(loopOutputApprovals)
		.where(eq(loopOutputApprovals.id, id))
		.limit(1)
	if (!row || !(await isWorkspaceMember(db, actorId, row.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Approval not found'), 404)
	}
	return c.json(serialize(row) as z.infer<typeof loopApprovalResponseSchema>)
}) as RouteHandler<typeof getLoopApprovalRoute, Env>)

// POST /api/loop-approvals/:id/approve
const approveLoopApprovalRoute = createRoute({
	method: 'post',
	path: '/{id}/approve',
	tags: ['loop-approvals'],
	summary: 'Approve a pending output, optionally with an edit + correction note',
	description:
		"Transitions the row from `pending` to `approved` and fans out `loop_output_delivered`. When `edited_payload` or `correction_note` is set, additionally fans out `loop_output_corrected` at the driver actor — that pair is the labelled training signal task 3's performance-score work will consume.",
	request: {
		params: idParamSchema,
		body: {
			content: { 'application/json': { schema: approveLoopApprovalSchema } },
		},
	},
	responses: {
		200: {
			description: 'Approved',
			content: { 'application/json': { schema: loopApprovalResponseSchema } },
		},
		404: {
			description: 'Not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'Approval already decided',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(approveLoopApprovalRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	const [row] = await db
		.select()
		.from(loopOutputApprovals)
		.where(eq(loopOutputApprovals.id, id))
		.limit(1)
	if (!row || !(await isWorkspaceMember(db, actorId, row.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Approval not found'), 404)
	}
	if (row.status !== 'pending') {
		return c.json(
			createApiError('CONFLICT', `Approval already ${row.status}`, [
				{ field: 'status', message: `Cannot approve — current status is ${row.status}` },
			]),
			409,
		)
	}

	const editedPayload = body.edited_payload ?? null
	const correctionNote = body.correction_note ?? null
	const isCorrection = editedPayload !== null || correctionNote !== null
	const now = new Date()

	const [updated] = await db
		.update(loopOutputApprovals)
		.set({
			status: 'approved',
			editedPayload,
			correctionNote,
			decidedBy: actorId,
			decidedAt: now,
			updatedAt: now,
		})
		.where(and(eq(loopOutputApprovals.id, id), eq(loopOutputApprovals.status, 'pending')))
		.returning()
	if (!updated) {
		// Lost a race with another concurrent decision — treat as conflict, same
		// message as the pre-update check so callers see one code path.
		return c.json(
			createApiError('CONFLICT', 'Approval already decided', [
				{ field: 'status', message: 'Row was decided by another request before this one landed' },
			]),
			409,
		)
	}

	// Delivery event carries the final payload (edited if any) — subscribers
	// downstream only need to read this one field to hand off.
	await db.insert(events).values({
		workspaceId: updated.workspaceId,
		actorId,
		action: 'loop_output_delivered',
		entityType: 'loop_output_approval',
		entityId: updated.id,
		data: {
			loop_id: updated.loopId,
			session_id: updated.sessionId,
			driver_actor_id: updated.driverActorId,
			delivered_payload: editedPayload ?? updated.payload,
			was_edited: isCorrection,
		},
	})

	// Correction event only when the human actually edited — this is the
	// labelled training signal the driver-agent side consumes.
	if (isCorrection && updated.driverActorId) {
		await db.insert(events).values({
			workspaceId: updated.workspaceId,
			actorId,
			action: 'loop_output_corrected',
			entityType: 'actor',
			entityId: updated.driverActorId,
			data: {
				approval_id: updated.id,
				loop_id: updated.loopId,
				session_id: updated.sessionId,
				original_payload: updated.payload,
				edited_payload: editedPayload,
				correction_note: correctionNote,
			},
		})
	}

	return c.json(serialize(updated) as z.infer<typeof loopApprovalResponseSchema>)
}) as RouteHandler<typeof approveLoopApprovalRoute, Env>)

// POST /api/loop-approvals/:id/reject
const rejectLoopApprovalRoute = createRoute({
	method: 'post',
	path: '/{id}/reject',
	tags: ['loop-approvals'],
	summary: 'Reject a pending output; discard the delivery',
	description:
		'Transitions the row from `pending` to `rejected` and fans out `loop_output_rejected` at the driver actor so it can course-correct. No delivery fanout on reject — the output is discarded.',
	request: {
		params: idParamSchema,
		body: {
			content: { 'application/json': { schema: rejectLoopApprovalSchema } },
		},
	},
	responses: {
		200: {
			description: 'Rejected',
			content: { 'application/json': { schema: loopApprovalResponseSchema } },
		},
		404: {
			description: 'Not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'Approval already decided',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(rejectLoopApprovalRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { reason } = c.req.valid('json')

	const [row] = await db
		.select()
		.from(loopOutputApprovals)
		.where(eq(loopOutputApprovals.id, id))
		.limit(1)
	if (!row || !(await isWorkspaceMember(db, actorId, row.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Approval not found'), 404)
	}
	if (row.status !== 'pending') {
		return c.json(
			createApiError('CONFLICT', `Approval already ${row.status}`, [
				{ field: 'status', message: `Cannot reject — current status is ${row.status}` },
			]),
			409,
		)
	}

	const now = new Date()
	const [updated] = await db
		.update(loopOutputApprovals)
		.set({
			status: 'rejected',
			correctionNote: reason ?? null,
			decidedBy: actorId,
			decidedAt: now,
			updatedAt: now,
		})
		.where(and(eq(loopOutputApprovals.id, id), eq(loopOutputApprovals.status, 'pending')))
		.returning()
	if (!updated) {
		return c.json(
			createApiError('CONFLICT', 'Approval already decided', [
				{ field: 'status', message: 'Row was decided by another request before this one landed' },
			]),
			409,
		)
	}

	// Route the rejection at the driver actor when we have one — this is what
	// makes the discarded output visible as a training signal.
	if (updated.driverActorId) {
		await db.insert(events).values({
			workspaceId: updated.workspaceId,
			actorId,
			action: 'loop_output_rejected',
			entityType: 'actor',
			entityId: updated.driverActorId,
			data: {
				approval_id: updated.id,
				loop_id: updated.loopId,
				session_id: updated.sessionId,
				original_payload: updated.payload,
				reason: reason ?? null,
			},
		})
	} else {
		// No driver captured — still audit the reject against the approval row so
		// the queue history stays complete.
		await db.insert(events).values({
			workspaceId: updated.workspaceId,
			actorId,
			action: 'loop_output_rejected',
			entityType: 'loop_output_approval',
			entityId: updated.id,
			data: {
				loop_id: updated.loopId,
				session_id: updated.sessionId,
				reason: reason ?? null,
			},
		})
	}

	return c.json(serialize(updated) as z.infer<typeof loopApprovalResponseSchema>)
}) as RouteHandler<typeof rejectLoopApprovalRoute, Env>)

export default app
