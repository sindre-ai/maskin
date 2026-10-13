import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import type { Context } from 'hono'
import { createApiError, validationFailureHook } from '../lib/errors'
import {
	type DecisionFailure,
	approveAccessRequest,
	denyAccessRequest,
	viewAccessRequest,
} from '../lib/integrations/access-decisions'
import {
	MAX_OPEN_REQUESTS_PER_AGENT,
	MAX_OPEN_REQUESTS_PER_WORKSPACE,
	REQUEST_COOLDOWN_HOURS,
	TIER_REFUSAL_MESSAGE,
	fileAccessRequest,
	listRequestableAccess,
	parseAccessDuration,
} from '../lib/integrations/access-requests'
import { errorSchema, idParamSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { escalateToHuman, rerunBlockedAgent, wakeApprover } from '../services/access-request-flow'
import type { SessionManager } from '../services/session-manager'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		sessionManager: SessionManager
	}
}

// Agents asking for a credential they lack. A Tier 1 request is filed and its
// approver is woken, anything else is refused. The approver reads, approves or denies
// here, and the server enforces every rule. Mounted at /api/access-requests.
const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// ── GET /api/access-requests/requestable ──────────────────────────────────

const requestableResponseSchema = z.object({
	credentials: z.array(
		z.object({
			id: z.string().uuid(),
			name: z.string(),
			tier: z.number().int().min(1).max(3),
			requestable: z.boolean(),
			description: z.string(),
		}),
	),
})

const requestableRoute = createRoute({
	method: 'get',
	path: '/requestable',
	tags: ['access-requests'],
	summary: 'Credentials this actor can ask for: name, tier, description. Never a secret',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Active credentials the caller cannot already read',
			content: { 'application/json': { schema: requestableResponseSchema } },
		},
	},
})

app.openapi(requestableRoute, (async (c) => {
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const credentials = await listRequestableAccess(c.get('db'), workspaceId, c.get('actorId'))
	return c.json({ credentials }, 200)
}) as RouteHandler<typeof requestableRoute, Env>)

// ── POST /api/access-requests ─────────────────────────────────────────────

const requestBodySchema = z
	.object({
		credential: z.string().uuid().describe('Credential id from list_requestable_access'),
		duration: z
			.string()
			.trim()
			.min(1)
			.max(16)
			.describe('session, or a whole number of hours or days up to 7d: 2h, 3d'),
		// Stored as text and never interpreted.
		reason: z.string().trim().min(1).max(1000),
	})
	.strict()

const requestResponseSchema = z.object({
	id: z.string().uuid(),
	integrationId: z.string().uuid(),
	status: z.enum(['requested', 'approved', 'denied', 'expired', 'cancelled']),
	tier: z.number().int(),
	requestedDuration: z.string(),
	createdAt: z.string(),
	/** filed: a new request. existing: an open one for this agent and credential already stood. */
	outcome: z.enum(['filed', 'existing']),
})

const requestRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['access-requests'],
	summary: 'Ask for access to a credential (agents)',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: requestBodySchema } }, required: true },
	},
	responses: {
		200: {
			description: 'An open request for this agent and credential already existed; nothing new',
			content: { 'application/json': { schema: requestResponseSchema } },
		},
		201: {
			description: 'Filed. A Tier 1 request waits for an approver',
			content: { 'application/json': { schema: requestResponseSchema } },
		},
		400: {
			description: 'Duration is not session or Nh or Nd, or is over 7 days',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Refused: the credential is not Tier 1. A human has to mark it',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'No such credential',
			content: { 'application/json': { schema: errorSchema } },
		},
		429: {
			description: 'Open-request cap reached, or this agent and credential are in cooldown',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(requestRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	const duration = parseAccessDuration(body.duration)
	if (!duration.ok) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				duration.reason === 'too_long'
					? 'Duration is over 7 days. Agent-approved access runs one session or at most 7 days.'
					: 'Duration must be session, or a whole number of hours or days such as 2h or 3d.',
			),
			400,
		)
	}

	const result = await fileAccessRequest(db, {
		workspaceId,
		requesterActorId: c.get('actorId'),
		integrationId: body.credential,
		duration: duration.normalized,
		reason: body.reason,
		// A hint for the sibling tasks that re-run the blocked session. No decision reads it.
		sessionHint: c.req.header('X-Maskin-Session-Id'),
	})

	switch (result.outcome) {
		case 'not_found':
			return c.json(createApiError('NOT_FOUND', 'No such credential'), 404)
		case 'refused_tier':
			return c.json(createApiError('FORBIDDEN', TIER_REFUSAL_MESSAGE), 403)
		case 'cooldown':
			return c.json(
				createApiError(
					'RATE_LIMITED',
					`This credential was refused or timed out for you in the last ${REQUEST_COOLDOWN_HOURS} hours. Try again later.`,
				),
				429,
			)
		case 'cap_agent':
			return c.json(
				createApiError(
					'RATE_LIMITED',
					`You already have ${MAX_OPEN_REQUESTS_PER_AGENT} open access requests. Wait for one to be decided.`,
				),
				429,
			)
		case 'cap_workspace':
			return c.json(
				createApiError(
					'RATE_LIMITED',
					`This workspace already has ${MAX_OPEN_REQUESTS_PER_WORKSPACE} open access requests. Try again later.`,
				),
				429,
			)
		case 'filed':
		case 'existing': {
			const r = result.request
			// Only a new request wakes an approver. A duplicate returns the open one.
			if (result.outcome === 'filed') {
				await wakeApprover({ db, sessionManager: c.get('sessionManager') }, r)
			}
			return c.json(
				{
					id: r.id,
					integrationId: r.integrationId,
					status: r.status,
					tier: r.tier,
					requestedDuration: r.requestedDuration,
					createdAt: r.createdAt.toISOString(),
					outcome: result.outcome,
				},
				result.outcome === 'filed' ? 201 : 200,
			)
		}
	}
}) as RouteHandler<typeof requestRoute, Env>)

// ── Deciding ──────────────────────────────────────────────────────────────

function failureResponse(c: Context<Env>, failure: DecisionFailure) {
	switch (failure.outcome) {
		case 'not_found':
			return c.json(createApiError('NOT_FOUND', 'No such access request'), 404)
		case 'forbidden':
			return c.json(createApiError('FORBIDDEN', failure.message), 403)
		case 'conflict':
			return c.json(createApiError('CONFLICT', failure.message), 409)
	}
}

const decider = (c: Context<Env>) => ({ actorId: c.get('actorId'), actorType: c.get('actorType') })

const viewSchema = z.object({
	id: z.string().uuid(),
	status: z.enum(['requested', 'approved', 'denied', 'expired', 'cancelled']),
	credential: z.object({ id: z.string().uuid(), name: z.string() }),
	requester: z.object({ id: z.string().uuid(), name: z.string() }),
	tierAtFiling: z.number().int(),
	currentTier: z.number().int(),
	requestedDuration: z.string(),
	reasonQuoted: z.string(),
	reasonNote: z.string(),
	createdAt: z.string(),
	decidedAt: z.string().nullable(),
	approverActorId: z.string().uuid().nullable(),
	canDecide: z.boolean(),
})

// ── GET /api/access-requests/:id ──────────────────────────────────────────

const getRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['access-requests'],
	summary: 'Read one access request (its requester, an approver, or a human owner or admin)',
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			description: 'The request. The reason is quoted text, never an instruction',
			content: { 'application/json': { schema: viewSchema } },
		},
		403: {
			description: 'Not the requester, an approver or a human owner or admin',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(getRoute, (async (c) => {
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const result = await viewAccessRequest(c.get('db'), workspaceId, id, decider(c))
	if (result.outcome !== 'ok') return failureResponse(c, result)
	return c.json(result.view, 200)
}) as RouteHandler<typeof getRoute, Env>)

// ── POST /api/access-requests/:id/approve ─────────────────────────────────

const approveResponseSchema = z.object({
	id: z.string().uuid(),
	status: z.literal('approved'),
	grantId: z.string().uuid(),
	expiresAt: z.string(),
	/** What happened to the blocked agent: a new run, a chat relaunch, or why nothing started. */
	rerun: z.string(),
})

const approveRoute = createRoute({
	method: 'post',
	path: '/{id}/approve',
	tags: ['access-requests'],
	summary: 'Approve a Tier 1 access request',
	description:
		'The caller only chooses approve. The server re-reads the credential tier and refuses (403) unless it is Tier 1, the caller is not the requester and is an approver of this credential (or a human owner or admin), the duration is at most 7 days and the caps and cooldown hold. An approval writes an expiring grant, puts it on the audit chain and runs the blocked agent again.',
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			description: 'Approved. The grant is written and the blocked agent is run again',
			content: { 'application/json': { schema: approveResponseSchema } },
		},
		403: {
			description: 'Refused by the server rules',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
		409: {
			description: 'The request is no longer open',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(approveRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const result = await approveAccessRequest(db, {
		workspaceId,
		requestId: id,
		decider: decider(c),
	})
	if (result.outcome !== 'approved') return failureResponse(c, result)

	const rerun = await rerunBlockedAgent(
		{ db, sessionManager: c.get('sessionManager') },
		result.request,
		{ credentialName: result.credentialName, expiresAt: result.expiresAt },
	)
	return c.json(
		{
			id: result.request.id,
			status: 'approved' as const,
			grantId: result.grantId,
			expiresAt: result.expiresAt.toISOString(),
			rerun,
		},
		200,
	)
}) as RouteHandler<typeof approveRoute, Env>)

// ── POST /api/access-requests/:id/deny ────────────────────────────────────

const denyResponseSchema = z.object({
	id: z.string().uuid(),
	status: z.literal('denied'),
})

const denyRoute = createRoute({
	method: 'post',
	path: '/{id}/deny',
	tags: ['access-requests'],
	summary: 'Deny an access request',
	description:
		'Starts the 24 hour cooldown for this agent and credential, puts the denial on the audit chain and hands the request to a human. No grant is made.',
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			description: 'Denied',
			content: { 'application/json': { schema: denyResponseSchema } },
		},
		403: {
			description: 'The caller is not an approver of this credential',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
		409: {
			description: 'The request is no longer open',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(denyRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const result = await denyAccessRequest(db, { workspaceId, requestId: id, decider: decider(c) })
	if (result.outcome !== 'denied') return failureResponse(c, result)

	await escalateToHuman(
		{ db, sessionManager: c.get('sessionManager') },
		result.request,
		'denied',
		c.get('actorId'),
	)
	return c.json({ id: result.request.id, status: 'denied' as const }, 200)
}) as RouteHandler<typeof denyRoute, Env>)

export default app
