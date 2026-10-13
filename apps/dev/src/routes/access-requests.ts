import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { createApiError, validationFailureHook } from '../lib/errors'
import {
	MAX_OPEN_REQUESTS_PER_AGENT,
	MAX_OPEN_REQUESTS_PER_WORKSPACE,
	REQUEST_COOLDOWN_HOURS,
	TIER_REFUSAL_MESSAGE,
	fileAccessRequest,
	listRequestableAccess,
	parseAccessDuration,
} from '../lib/integrations/access-requests'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

// Agents asking for a credential they lack. No approval here: a Tier 1 request
// is filed and waits, anything else is refused. Mounted at /api/access-requests.
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

export default app
