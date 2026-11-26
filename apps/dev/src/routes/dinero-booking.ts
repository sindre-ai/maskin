import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { DINERO_BOOKING_STATEMENT } from '../lib/integrations/providers/dinero/booking-switch'
import { DINERO_PROVIDER } from '../lib/integrations/providers/dinero/config'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import type { IntegrationConfig } from '../lib/types'
import { assertWorkspaceWriterRole, isWorkspaceHumanAdminOrOwner } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		workspaceRole?: string
	}
}

// The owner's booking switch for Dinero. It lives in the Dinero integration's config
// (dinero_booking), which picks the fixed list of tools the gateway lets an agent use. Only a
// person who is an admin or owner of the workspace can change it: an agent never can, whatever
// its access, because the gateway reads the switch and nothing an agent can call writes it.
const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const stateSchema = z.object({
	enabled: z.boolean(),
	statement: z.string(),
	set_by: z.string().uuid().nullable(),
	set_at: z.string().nullable(),
})

const errorResponses = {
	400: { description: 'Invalid', content: { 'application/json': { schema: errorSchema } } },
	403: { description: 'Not allowed', content: { 'application/json': { schema: errorSchema } } },
	404: {
		description: 'Dinero is not connected',
		content: { 'application/json': { schema: errorSchema } },
	},
}

type BookingConfig = IntegrationConfig & {
	dinero_booking_set_by?: string
	dinero_booking_set_at?: string
}

async function loadDinero(db: Database, workspaceId: string) {
	const [row] = await db
		.select({ id: integrations.id, config: integrations.config })
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

function stateOf(config: BookingConfig | null) {
	return {
		enabled: config?.dinero_booking === true,
		statement: DINERO_BOOKING_STATEMENT,
		set_by: config?.dinero_booking_set_by ?? null,
		set_at: config?.dinero_booking_set_at ?? null,
	}
}

const getRoute = createRoute({
	method: 'get',
	path: '/',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Read the Dinero booking switch and what switching it on means',
	request: { headers: workspaceIdHeader },
	responses: {
		200: { description: 'The switch', content: { 'application/json': { schema: stateSchema } } },
		...errorResponses,
	},
})

app.openapi(getRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const row = await loadDinero(db, workspaceId)
	if (!row) return c.json(createApiError('NOT_FOUND', 'Dinero is not connected'), 404)
	return c.json(stateOf(row.config as BookingConfig | null), 200)
}) as RouteHandler<typeof getRoute, Env>)

const putRoute = createRoute({
	method: 'put',
	path: '/',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Switch Dinero booking on or off (a workspace admin or owner who is a person)',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': {
					schema: z
						.object({
							enabled: z.boolean(),
							// Switching on needs this: the caller confirms the person was shown the statement.
							acknowledged: z.boolean().optional(),
						})
						.strict(),
				},
			},
			required: true,
		},
	},
	responses: {
		200: {
			description: 'The switch now',
			content: { 'application/json': { schema: stateSchema } },
		},
		...errorResponses,
	},
})

app.openapi(putRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	if (
		c.get('actorType') !== 'human' ||
		!(await isWorkspaceHumanAdminOrOwner(db, actorId, workspaceId))
	) {
		return c.json(
			createApiError('FORBIDDEN', 'Only a person who is an admin or owner can change booking'),
			403,
		)
	}
	const { enabled, acknowledged } = c.req.valid('json')
	if (enabled && acknowledged !== true) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				'Show the person what booking means, then send acknowledged: true',
			),
			400,
		)
	}
	const row = await loadDinero(db, workspaceId)
	if (!row) return c.json(createApiError('NOT_FOUND', 'Dinero is not connected'), 404)

	const next: BookingConfig = {
		...((row.config as BookingConfig | null) ?? {}),
		dinero_booking: enabled,
		dinero_booking_set_by: actorId,
		dinero_booking_set_at: new Date().toISOString(),
	}
	await db.update(integrations).set({ config: next }).where(eq(integrations.id, row.id))
	await recordEvent(db, {
		workspaceId,
		actorId,
		action: 'dinero_booking_switched',
		entityType: 'integration',
		entityId: row.id,
		data: { enabled },
	})
	return c.json(stateOf(next), 200)
}) as RouteHandler<typeof putRoute, Env>)

export default app
