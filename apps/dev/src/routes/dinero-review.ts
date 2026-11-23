import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { TokenManager } from '../lib/integrations/oauth/token-manager'
import {
	DINERO_ACTION_EVENT,
	loggedArguments,
} from '../lib/integrations/providers/dinero/action-log'
import { DINERO_PROVIDER } from '../lib/integrations/providers/dinero/config'
import {
	approvalSubject,
	callDineroAsOwner,
	counterPostingArguments,
	figuresOf,
	findPeriodApproval,
	isIsoDate,
	readReviewLog,
} from '../lib/integrations/providers/dinero/review'
import { getProvider } from '../lib/integrations/registry'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import {
	OWNER_APPROVAL_DINERO_BOOKS,
	findOwnerApprovals,
	hashFigures,
	recordOwnerApproval,
} from '../lib/owner-approval'
import { assertWorkspaceWriterRole, isWorkspaceHumanAdminOrOwner } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		workspaceRole?: string
	}
}

// The owner's review screen for Dinero: the log of what the flow did, a one-click reversal of a
// booked item, and the final "Approve the books". The log holds voucher figures and Dinero's
// answers, so every route is for a person who is an admin or owner of the workspace, never an
// agent. The approval is written to the shared owner approval record (lib/owner-approval.ts).
const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const DAY_MS = 86_400_000

/** Postgres unique_violation (23505), also when Drizzle wraps it as the cause. */
function isUniqueViolation(err: unknown): boolean {
	for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
		if ((e as { code?: string }).code === '23505') return true
	}
	return false
}

const errorResponses = {
	400: { description: 'Invalid', content: { 'application/json': { schema: errorSchema } } },
	403: { description: 'Not allowed', content: { 'application/json': { schema: errorSchema } } },
	404: {
		description: 'Dinero is not connected',
		content: { 'application/json': { schema: errorSchema } },
	},
	409: { description: 'Closed', content: { 'application/json': { schema: errorSchema } } },
}

const dateString = z.string().refine(isIsoDate, 'Use a date like 2026-11-30')

const itemSchema = z.object({
	event_id: z.number(),
	at: z.string().nullable(),
	tool: z.string(),
	outcome: z.string(),
	booked: z.boolean(),
	voucher_date: z.string().nullable(),
	lines: z.array(
		z.object({
			description: z.string().nullable(),
			amount: z.number().nullable(),
			account: z.number().nullable(),
			counter_account: z.number().nullable(),
			vat_code: z.string().nullable(),
		}),
	),
	result: z.string().nullable(),
	reverses_event_id: z.number().nullable(),
	reversed_by_event_id: z.number().nullable(),
	can_reverse: z.boolean(),
	cannot_reverse_because: z.string().nullable(),
})

const approvalSchema = z
	.object({ approved_by: z.string().uuid(), approved_at: z.string(), figures_hash: z.string() })
	.nullable()

const logSchema = z.object({
	from: z.string(),
	to: z.string(),
	items: z.array(itemSchema),
	figures_hash: z.string(),
	approval: approvalSchema,
	truncated: z.boolean(),
})

async function loadDinero(db: Database, workspaceId: string) {
	const [row] = await db
		.select({ id: integrations.id })
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, DINERO_PROVIDER),
				eq(integrations.providerMode, 'registered'),
				eq(integrations.status, 'active'),
			),
		)
		.limit(1)
	return row ?? null
}

async function requireOwnerPerson(
	db: Database,
	who: { actorId: string; actorType: string; workspaceRole: string | undefined },
	workspaceId: string,
) {
	assertWorkspaceWriterRole(who.workspaceRole)
	return (
		who.actorType === 'human' && (await isWorkspaceHumanAdminOrOwner(db, who.actorId, workspaceId))
	)
}

const FORBIDDEN_TEXT = 'Only a person who is an admin or owner can open the Dinero review'

function windowOf(from?: string, to?: string): { from: string; to: string } {
	const today = new Date()
	const end = to ?? today.toISOString().slice(0, 10)
	const start =
		from ?? new Date(Date.parse(`${end}T00:00:00Z`) - 30 * DAY_MS).toISOString().slice(0, 10)
	return { from: start, to: end }
}

async function buildLog(
	db: Database,
	workspaceId: string,
	integrationId: string,
	w: { from: string; to: string },
) {
	const items = await readReviewLog(db, { workspaceId, integrationId, ...w })
	const approval = await findPeriodApproval(db, { workspaceId, integrationId, ...w })
	return {
		...w,
		items,
		figures_hash: hashFigures(figuresOf(items)),
		approval: approval
			? {
					approved_by: approval.approvedBy,
					approved_at: approval.approvedAt.toISOString(),
					figures_hash: approval.figuresHash,
				}
			: null,
		truncated: items.length >= 2000,
	}
}

const getRoute = createRoute({
	method: 'get',
	path: '/',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'The Dinero action log for a period, for the owner review screen',
	request: {
		headers: workspaceIdHeader,
		query: z.object({ from: dateString.optional(), to: dateString.optional() }),
	},
	responses: {
		200: { description: 'The log', content: { 'application/json': { schema: logSchema } } },
		...errorResponses,
	},
})

app.openapi(getRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	if (
		!(await requireOwnerPerson(
			db,
			{
				actorId: c.get('actorId'),
				actorType: c.get('actorType'),
				workspaceRole: c.get('workspaceRole'),
			},
			workspaceId,
		))
	) {
		return c.json(createApiError('FORBIDDEN', FORBIDDEN_TEXT), 403)
	}
	const { from, to } = c.req.valid('query')
	const w = windowOf(from, to)
	if (w.from > w.to) return c.json(createApiError('BAD_REQUEST', 'from is after to'), 400)
	const row = await loadDinero(db, workspaceId)
	if (!row) return c.json(createApiError('NOT_FOUND', 'Dinero is not connected'), 404)
	return c.json(await buildLog(db, workspaceId, row.id, w), 200)
}) as RouteHandler<typeof getRoute, Env>)

const reverseRoute = createRoute({
	method: 'post',
	path: '/reverse',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Reverse one booked item in Dinero with a counter-posting (a person, admin or owner)',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': {
					schema: z.object({ event_id: z.number().int().positive() }).strict(),
				},
			},
			required: true,
		},
	},
	responses: {
		200: {
			description: 'What Dinero answered',
			content: {
				'application/json': {
					schema: z.object({
						outcome: z.enum(['success', 'error']),
						message: z.string().nullable(),
						reversal_event_id: z.number(),
					}),
				},
			},
		},
		...errorResponses,
	},
})

app.openapi(reverseRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	if (
		!(await requireOwnerPerson(
			db,
			{
				actorId: c.get('actorId'),
				actorType: c.get('actorType'),
				workspaceRole: c.get('workspaceRole'),
			},
			workspaceId,
		))
	) {
		return c.json(createApiError('FORBIDDEN', FORBIDDEN_TEXT), 403)
	}
	const { event_id: eventId } = c.req.valid('json')
	const row = await loadDinero(db, workspaceId)
	if (!row) return c.json(createApiError('NOT_FOUND', 'Dinero is not connected'), 404)

	const [ev] = await db
		.select({ id: events.id, data: events.data, createdAt: events.createdAt })
		.from(events)
		.where(
			and(
				eq(events.id, eventId),
				eq(events.workspaceId, workspaceId),
				eq(events.entityId, row.id),
				eq(events.action, DINERO_ACTION_EVENT),
			),
		)
		.limit(1)
	if (!ev) return c.json(createApiError('NOT_FOUND', 'No such log entry'), 404)
	const data = (ev.data ?? {}) as Record<string, unknown>

	// Look at the day of the entry in the log as the owner sees it: reversed already, or closed.
	const day = (ev.createdAt ?? new Date()).toISOString().slice(0, 10)
	const view = await buildLog(db, workspaceId, row.id, { from: day, to: day })
	const item = view.items.find((i) => i.event_id === eventId)
	const closed = await closedPeriodOf(db, workspaceId, row.id, day)
	if (closed) {
		return c.json(
			createApiError('CONFLICT', 'The books for this period are approved and closed here'),
			409,
		)
	}
	if (item?.reversed_by_event_id != null) {
		return c.json(createApiError('CONFLICT', 'This item is already reversed'), 409)
	}
	const plan = counterPostingArguments(
		typeof data.tool === 'string' ? data.tool : '',
		(data.arguments ?? null) as Record<string, unknown> | null,
		eventId,
	)
	if (!item?.booked || !plan.ok) {
		return c.json(
			createApiError('BAD_REQUEST', plan.ok ? 'Only a booked item can be reversed' : plan.reason),
			400,
		)
	}

	let token: string
	try {
		token = await new TokenManager().getValidToken(db, row.id, getProvider(DINERO_PROVIDER))
	} catch {
		return c.json(
			createApiError('BAD_REQUEST', 'Dinero needs to be reconnected under Settings → Integrations'),
			400,
		)
	}
	let answer: { ok: boolean; text: string | null }
	try {
		answer = await callDineroAsOwner(token, 'CreateFinanceVoucher', plan.args)
	} catch {
		answer = { ok: false, text: 'Dinero could not be reached. Nothing was changed.' }
	}
	const outcome = answer.ok ? 'success' : 'error'
	// The counter-posting is a log line of its own, linked to the item it undoes.
	const [logged] = await db
		.insert(events)
		.values({
			workspaceId,
			actorId,
			action: DINERO_ACTION_EVENT,
			entityType: 'integration',
			entityId: row.id,
			data: {
				tool: 'CreateFinanceVoucher',
				arguments: loggedArguments(plan.args),
				outcome,
				result: answer.text,
				booking_switch: null,
				session_id: null,
				reverses_event_id: eventId,
				by_owner: true,
			},
		})
		.returning({ id: events.id })
	return c.json({ outcome, message: answer.text, reversal_event_id: logged?.id ?? 0 } as const, 200)
}) as RouteHandler<typeof reverseRoute, Env>)

/** The approved period of this connection that covers the day, or null. */
async function closedPeriodOf(
	db: Database,
	workspaceId: string,
	integrationId: string,
	day: string,
) {
	const all = await findOwnerApprovals(db, workspaceId, OWNER_APPROVAL_DINERO_BOOKS)
	const prefix = `dinero:${integrationId}:`
	for (const a of all) {
		if (!a.subject.startsWith(prefix)) continue
		const [from, to] = a.subject.slice(prefix.length).split(':')
		if (from && to && from <= day && day <= to) return a
	}
	return null
}

const approveRoute = createRoute({
	method: 'post',
	path: '/approve',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Approve the books for a period: one entry in the owner approval record (a person)',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': {
					schema: z
						.object({
							from: dateString,
							to: dateString,
							// The hash of the figures the person was shown. A log that moved since is refused.
							figures_hash: z.string().min(16),
						})
						.strict(),
				},
			},
			required: true,
		},
	},
	responses: {
		200: {
			description: 'The log, now locked',
			content: { 'application/json': { schema: logSchema } },
		},
		...errorResponses,
	},
})

app.openapi(approveRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	if (
		!(await requireOwnerPerson(
			db,
			{
				actorId: c.get('actorId'),
				actorType: c.get('actorType'),
				workspaceRole: c.get('workspaceRole'),
			},
			workspaceId,
		))
	) {
		return c.json(createApiError('FORBIDDEN', FORBIDDEN_TEXT), 403)
	}
	const body = c.req.valid('json')
	if (body.from > body.to) return c.json(createApiError('BAD_REQUEST', 'from is after to'), 400)
	const row = await loadDinero(db, workspaceId)
	if (!row) return c.json(createApiError('NOT_FOUND', 'Dinero is not connected'), 404)

	if (
		await findPeriodApproval(db, {
			workspaceId,
			integrationId: row.id,
			from: body.from,
			to: body.to,
		})
	) {
		return c.json(createApiError('CONFLICT', 'This period is already approved'), 409)
	}
	const view = await buildLog(db, workspaceId, row.id, { from: body.from, to: body.to })
	if (view.figures_hash !== body.figures_hash) {
		return c.json(
			createApiError(
				'CONFLICT',
				'The log changed since you opened it. Look at it again, then approve',
			),
			409,
		)
	}
	try {
		await recordOwnerApproval(db, {
			workspaceId,
			kind: OWNER_APPROVAL_DINERO_BOOKS,
			subject: approvalSubject(row.id, body.from, body.to),
			figuresHash: view.figures_hash,
			approvedBy: actorId,
		})
	} catch (e) {
		// Two approvals at the same instant: the unique index let one through.
		if (isUniqueViolation(e)) {
			return c.json(createApiError('CONFLICT', 'This period is already approved'), 409)
		}
		throw e
	}
	await recordEvent(db, {
		workspaceId,
		actorId,
		action: 'dinero_books_approved',
		entityType: 'integration',
		entityId: row.id,
		data: {
			from: body.from,
			to: body.to,
			figures_hash: view.figures_hash,
			items: view.items.length,
		},
	})
	return c.json(await buildLog(db, workspaceId, row.id, { from: body.from, to: body.to }), 200)
}) as RouteHandler<typeof approveRoute, Env>)

export default app
