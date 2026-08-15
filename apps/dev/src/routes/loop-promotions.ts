import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { loopPromotionProposals } from '@maskin/db/schema'
import {
	decideLoopPromotionSchema,
	listLoopPromotionProposalsQuerySchema,
	loopPromotionProposalResponseSchema,
} from '@maskin/shared'
import { and, desc, eq } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { errorSchema, idParamSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import { isWorkspaceMember } from '../lib/workspace-auth'
import {
	approvePromotionProposal,
	deferPromotionProposal,
	rejectPromotionProposal,
} from '../services/loop-lifecycle'

/**
 * Human decision surface for rung-graduation proposals (T5 of
 * bet/loop-lifecycle-status-ladder). The proposals themselves are written by
 * the loop-lifecycle service (`apps/dev/src/services/loop-lifecycle.ts`)
 * whenever a `human_approved` loop's score climbs past its rung threshold;
 * this file exposes the read + approve/reject/defer actions.
 *
 * All state transitions are one-way — pending → approved | rejected |
 * deferred — mirroring the T7 output-approvals contract. Re-deciding an
 * already-decided proposal 409s so the human can't accidentally double-fire
 * a rung advance.
 *
 * Rejection leaves the loop at its current rung and captures the reason as
 * a labelled training signal on the proposal row. Defer also leaves the
 * loop at its current rung — the next run of `evaluateAfterRun` is free to
 * create a fresh proposal once the score conditions still hold.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// GET /api/loop-promotions
const listLoopPromotionsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['loop-promotions'],
	summary: 'List rung-promotion proposals in workspace',
	description:
		'Returns proposals newest first. Defaults to no status filter; pass `status=pending` for the queue view.',
	request: {
		headers: workspaceIdHeader,
		query: listLoopPromotionProposalsQuerySchema,
	},
	responses: {
		200: {
			description: 'Proposals',
			content: {
				'application/json': { schema: z.array(loopPromotionProposalResponseSchema) },
			},
		},
		400: {
			description: 'Missing workspace ID',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found or actor is not a member',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listLoopPromotionsRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { loop_id, status, limit, offset } = c.req.valid('query')

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	const conditions = [eq(loopPromotionProposals.workspaceId, workspaceId)]
	if (loop_id) conditions.push(eq(loopPromotionProposals.loopId, loop_id))
	if (status) conditions.push(eq(loopPromotionProposals.status, status))

	const rows = await db
		.select()
		.from(loopPromotionProposals)
		.where(and(...conditions))
		.orderBy(desc(loopPromotionProposals.createdAt))
		.limit(limit)
		.offset(offset)

	return c.json(serializeArray(rows) as z.infer<typeof loopPromotionProposalResponseSchema>[])
}) as RouteHandler<typeof listLoopPromotionsRoute, Env>)

// GET /api/loop-promotions/:id
const getLoopPromotionRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['loop-promotions'],
	summary: 'Fetch a single proposal by id',
	request: { params: idParamSchema },
	responses: {
		200: {
			description: 'Proposal',
			content: { 'application/json': { schema: loopPromotionProposalResponseSchema } },
		},
		404: {
			description: 'Not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(getLoopPromotionRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	const [row] = await db
		.select()
		.from(loopPromotionProposals)
		.where(eq(loopPromotionProposals.id, id))
		.limit(1)
	if (!row || !(await isWorkspaceMember(db, actorId, row.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Promotion proposal not found'), 404)
	}
	return c.json(serialize(row) as z.infer<typeof loopPromotionProposalResponseSchema>)
}) as RouteHandler<typeof getLoopPromotionRoute, Env>)

// POST /api/loop-promotions/:id/approve
const approveLoopPromotionRoute = createRoute({
	method: 'post',
	path: '/{id}/approve',
	tags: ['loop-promotions'],
	summary: 'Approve a pending proposal — advance the loop one rung',
	description:
		'Transitions the proposal to `approved` and advances the loop from `from_status` to `to_status`. Fans out `loop_promoted` on the loop and `loop_promotion_approved` on the proposal row. If the loop has since moved off `from_status` (a race with automatic demotion or a paused/archived transition), the proposal is still marked approved (the human decision is recorded) but the rung change is skipped.',
	request: {
		params: idParamSchema,
		body: {
			content: { 'application/json': { schema: decideLoopPromotionSchema } },
		},
	},
	responses: {
		200: {
			description: 'Approved',
			content: { 'application/json': { schema: loopPromotionProposalResponseSchema } },
		},
		404: {
			description: 'Not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'Proposal already decided',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(approveLoopPromotionRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	const [row] = await db
		.select({ workspaceId: loopPromotionProposals.workspaceId })
		.from(loopPromotionProposals)
		.where(eq(loopPromotionProposals.id, id))
		.limit(1)
	if (!row || !(await isWorkspaceMember(db, actorId, row.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Promotion proposal not found'), 404)
	}

	const result = await approvePromotionProposal(db, id, actorId)
	if (result === null) {
		return c.json(createApiError('NOT_FOUND', 'Promotion proposal not found'), 404)
	}
	if ('conflict' in result) {
		return c.json(
			createApiError('CONFLICT', 'Proposal already decided', [
				{ field: 'status', message: 'Row was decided by another request before this one landed' },
			]),
			409,
		)
	}

	const [refreshed] = await db
		.select()
		.from(loopPromotionProposals)
		.where(eq(loopPromotionProposals.id, id))
		.limit(1)
	if (!refreshed) {
		return c.json(createApiError('NOT_FOUND', 'Promotion proposal not found'), 404)
	}
	return c.json(serialize(refreshed) as z.infer<typeof loopPromotionProposalResponseSchema>)
}) as RouteHandler<typeof approveLoopPromotionRoute, Env>)

// POST /api/loop-promotions/:id/reject
const rejectLoopPromotionRoute = createRoute({
	method: 'post',
	path: '/{id}/reject',
	tags: ['loop-promotions'],
	summary: 'Reject a pending proposal — leave the loop at its current rung',
	request: {
		params: idParamSchema,
		body: {
			content: { 'application/json': { schema: decideLoopPromotionSchema } },
		},
	},
	responses: {
		200: {
			description: 'Rejected',
			content: { 'application/json': { schema: loopPromotionProposalResponseSchema } },
		},
		404: {
			description: 'Not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'Proposal already decided',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(rejectLoopPromotionRoute, (async (c) => {
	return decideRoute(c, 'rejected')
}) as RouteHandler<typeof rejectLoopPromotionRoute, Env>)

// POST /api/loop-promotions/:id/defer
const deferLoopPromotionRoute = createRoute({
	method: 'post',
	path: '/{id}/defer',
	tags: ['loop-promotions'],
	summary:
		'Defer a pending proposal — leave the loop at its current rung; next eval may re-propose',
	request: {
		params: idParamSchema,
		body: {
			content: { 'application/json': { schema: decideLoopPromotionSchema } },
		},
	},
	responses: {
		200: {
			description: 'Deferred',
			content: { 'application/json': { schema: loopPromotionProposalResponseSchema } },
		},
		404: {
			description: 'Not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'Proposal already decided',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(deferLoopPromotionRoute, (async (c) => {
	return decideRoute(c, 'deferred')
}) as RouteHandler<typeof deferLoopPromotionRoute, Env>)

async function decideRoute(
	// biome-ignore lint/suspicious/noExplicitAny: Hono's context type parameter varies per route; the handlers pass their own typed contexts through.
	c: any,
	kind: 'rejected' | 'deferred',
) {
	const db = c.get('db') as Database
	const actorId = c.get('actorId') as string
	const { id } = c.req.valid('param') as { id: string }
	const { reason } = c.req.valid('json') as { reason?: string }

	const [row] = await db
		.select({ workspaceId: loopPromotionProposals.workspaceId })
		.from(loopPromotionProposals)
		.where(eq(loopPromotionProposals.id, id))
		.limit(1)
	if (!row || !(await isWorkspaceMember(db, actorId, row.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Promotion proposal not found'), 404)
	}

	const result =
		kind === 'rejected'
			? await rejectPromotionProposal(db, id, actorId, reason ?? null)
			: await deferPromotionProposal(db, id, actorId, reason ?? null)
	if (result === null) {
		return c.json(createApiError('NOT_FOUND', 'Promotion proposal not found'), 404)
	}
	if ('conflict' in result) {
		return c.json(
			createApiError('CONFLICT', 'Proposal already decided', [
				{ field: 'status', message: 'Row was decided by another request before this one landed' },
			]),
			409,
		)
	}

	const [refreshed] = await db
		.select()
		.from(loopPromotionProposals)
		.where(eq(loopPromotionProposals.id, id))
		.limit(1)
	if (!refreshed) {
		return c.json(createApiError('NOT_FOUND', 'Promotion proposal not found'), 404)
	}
	return c.json(serialize(refreshed) as z.infer<typeof loopPromotionProposalResponseSchema>)
}

export default app
