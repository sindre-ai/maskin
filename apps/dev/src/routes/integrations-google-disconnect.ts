import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { disconnectIntegrationRow } from '../lib/integrations/disconnect'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

/** What each radio in the Disconnect Drive modal removes, as provider rows. */
export const GOOGLE_DISCONNECT_SCOPES = {
	drive: ['google-drive'],
	'drive-meet': ['google-drive', 'google-meet'],
	google: ['gmail', 'google-calendar', 'google-meet', 'google-drive'],
} as const

const disconnectGoogleRoute = createRoute({
	method: 'post',
	path: '/disconnect',
	tags: ['integrations'],
	summary: 'Disconnect a human Google rows (Drive, Drive + Meet, or the whole account)',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': {
					schema: z.object({
						email: z
							.string()
							.email()
							.describe('Google email of the human, matched case-insensitively'),
						scope: z
							.enum(['drive', 'drive-meet', 'google'])
							.describe(
								'drive: Drive row. drive-meet: Drive and Meet. google: all four Google rows',
							),
					}),
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Rows disconnected',
			content: {
				'application/json': {
					schema: z.object({
						disconnected: z.array(z.object({ id: z.string().uuid(), provider: z.string() })),
					}),
				},
			},
		},
		404: {
			description: 'No connected row for that email in this workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// A thin wrapper over the per-row disconnect: each matching row runs its own
// preDisconnect and revoke through disconnectIntegrationRow, the same code
// DELETE /api/integrations/:id runs. Rows are only ever selected by this
// workspace's id, so another workspace's rows cannot be reached. A provider the
// human has no row for is skipped, not an error.
app.openapi(disconnectGoogleRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { email, scope } = c.req.valid('json')

	const rows = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				inArray(integrations.provider, [...GOOGLE_DISCONNECT_SCOPES[scope]]),
				inArray(integrations.status, ['active', 'error']),
				sql`lower(${integrations.externalId}) = ${email.toLowerCase()}`,
			),
		)
	if (rows.length === 0) {
		return c.json(createApiError('NOT_FOUND', 'No connected Google row for that email'), 404)
	}

	for (const row of rows) {
		await disconnectIntegrationRow(db, row, actorId)
	}

	return c.json({ disconnected: rows.map((r) => ({ id: r.id, provider: r.provider })) })
}) as RouteHandler<typeof disconnectGoogleRoute, Env>)

export default app
