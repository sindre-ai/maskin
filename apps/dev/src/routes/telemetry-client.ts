import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { checkClientEvent } from '../lib/analytics/client-events'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { createApiError, validationFailureHook } from '../lib/errors'
import { createWindowLimiter } from '../lib/fixed-window-limiter'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { isWorkspaceMember } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const MAX_EVENTS_PER_BATCH = 50
// A phone sends a batch when the app goes to the background or a queue fills, so a minute holds
// a handful of honest batches. This is a brake on a stuck loop, not a quota.
const batchLimiter = createWindowLimiter({ limit: 30, windowMs: 60_000 })
// Events queued offline are sent later. A week back covers a long flight; anything older is
// stale, and a clock ahead of ours by more than a few minutes is wrong.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_FUTURE_MS = 5 * 60 * 1000

/** Exposed so tests do not poison each other through shared limiter state. */
export function resetClientTelemetryLimiterForTests() {
	batchLimiter.reset()
}

const clientEventSchema = z.object({
	name: z.string().min(1).max(64),
	properties: z.record(z.union([z.string().max(64), z.number(), z.boolean()])).default({}),
	occurred_at: z.string().datetime({ offset: true }),
})

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// POST /api/telemetry/client — a batch of product analytics events from the iPhone app.
const recordClientRoute = createRoute({
	method: 'post',
	path: '/client',
	tags: ['Telemetry'],
	summary: 'Record a batch of allowlisted product analytics events from the iPhone app.',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': {
					schema: z.object({
						events: z.array(clientEventSchema).min(1).max(MAX_EVENTS_PER_BATCH),
					}),
				},
			},
		},
	},
	responses: {
		202: {
			description:
				'Batch accepted. Events are dropped quietly when the workspace has usage sharing off.',
			content: { 'application/json': { schema: z.object({ accepted: z.number().int() }) } },
		},
		400: {
			description: 'Unknown event name, property that is not allowed, or invalid value',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Not a workspace member, or the caller is not a person',
			content: { 'application/json': { schema: errorSchema } },
		},
		429: { description: 'Rate limited', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(recordClientRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { events } = c.req.valid('json')

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Not a workspace member'), 403)
	}
	// The phone is a person. Events are stamped actor_type human, so an agent key cannot send them.
	if (c.get('actorType') !== 'human') {
		return c.json(createApiError('FORBIDDEN', 'Only a person can send app events'), 403)
	}

	const limit = batchLimiter.hit(actorId)
	if (!limit.allowed) {
		c.header('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)))
		return c.json(createApiError('RATE_LIMITED', 'Too many batches. Wait a minute.'), 429)
	}

	// Check the whole batch before sending any of it, so a refused batch sends nothing.
	const now = Date.now()
	for (const [index, event] of events.entries()) {
		const problem = checkClientEvent(index, event.name, event.properties)
		if (problem) {
			return c.json(
				createApiError('VALIDATION_ERROR', problem.message, [
					{ field: problem.path, message: problem.message },
				]),
				400,
			)
		}
		const at = new Date(event.occurred_at).getTime()
		if (at < now - MAX_AGE_MS || at > now + MAX_FUTURE_MS) {
			const path = `events[${index}].occurred_at`
			return c.json(
				createApiError('VALIDATION_ERROR', 'occurred_at is too old or in the future', [
					{
						field: path,
						message: 'occurred_at must be within the last 7 days and not ahead of the server',
					},
				]),
				400,
			)
		}
	}

	for (const event of events) {
		// workspace_id in the properties is what makes the capture function apply the workspace's
		// share-usage and anonymise settings: nothing is sent when sharing is off. Fire and forget,
		// it never throws.
		void capturePosthogEvent(
			event.name,
			actorId,
			{ ...event.properties, workspace_id: workspaceId, actor_id: actorId, actor_type: 'human' },
			{ surface: 'iphone', timestamp: new Date(event.occurred_at) },
		)
	}

	return c.json({ accepted: events.length }, 202)
}) as RouteHandler<typeof recordClientRoute, Env>)

export default app
