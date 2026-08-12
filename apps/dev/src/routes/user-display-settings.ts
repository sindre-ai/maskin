import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { userDisplaySettings } from '@maskin/db/schema'
import {
	listUserDisplaySettingsResponseSchema,
	upsertUserDisplaySettingsBodySchema,
	userDisplaySettingsParamsSchema,
	userDisplaySettingsResponseSchema,
} from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// V1 only reads/writes the `'default'` row per (actor, object_type). The
// `name` column is reserved for the Board View bet's saved views — see
// Task 1's persistence-schema decision on bet
// `Objects Page — Linear-inspired Display Control & Persistent Settings`.
const DEFAULT_NAME = 'default'

function serializeRow(row: typeof userDisplaySettings.$inferSelect) {
	return {
		object_type: row.objectType,
		name: row.name,
		settings: row.settings as Record<string, unknown>,
		updated_at: row.updatedAt.toISOString(),
	}
}

// GET /api/user-display-settings — list every default-row for the current actor.
// Used on app boot to hydrate the display panel cache for any object-type
// page the user opens.
const listRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['User Display Settings'],
	summary: 'List the current actor’s persisted display settings for this workspace',
	request: {
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			description: 'Display settings',
			content: { 'application/json': { schema: listUserDisplaySettingsResponseSchema } },
		},
	},
})

app.openapi(listRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const rows = await db
		.select()
		.from(userDisplaySettings)
		.where(
			and(
				eq(userDisplaySettings.workspaceId, workspaceId),
				eq(userDisplaySettings.actorId, actorId),
				eq(userDisplaySettings.name, DEFAULT_NAME),
			),
		)

	return c.json({ items: rows.map(serializeRow) }, 200)
})

// GET /api/user-display-settings/:object_type — fetch the actor's default
// settings row for one object type. 404 when no row exists yet so callers
// can fall back to client defaults without persisting an empty row.
const getRoute = createRoute({
	method: 'get',
	path: '/{object_type}',
	tags: ['User Display Settings'],
	summary: 'Get the current actor’s display settings for one object type',
	request: {
		headers: workspaceIdHeader,
		params: userDisplaySettingsParamsSchema,
	},
	responses: {
		200: {
			description: 'Display settings',
			content: { 'application/json': { schema: userDisplaySettingsResponseSchema } },
		},
		404: {
			description: 'No settings persisted yet for this object type',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(getRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { object_type } = c.req.valid('param')

	const [row] = await db
		.select()
		.from(userDisplaySettings)
		.where(
			and(
				eq(userDisplaySettings.workspaceId, workspaceId),
				eq(userDisplaySettings.actorId, actorId),
				eq(userDisplaySettings.objectType, object_type),
				eq(userDisplaySettings.name, DEFAULT_NAME),
			),
		)
		.limit(1)

	if (!row) {
		return c.json(createApiError('NOT_FOUND', 'No display settings for this object type'), 404)
	}

	return c.json(serializeRow(row), 200)
})

// PUT /api/user-display-settings/:object_type — upsert the default settings
// row for one object type. Replaces the full settings blob; the toolbar
// debounces and POSTs the whole shape so the server stays oblivious to the
// inner contract.
const upsertRoute = createRoute({
	method: 'put',
	path: '/{object_type}',
	tags: ['User Display Settings'],
	summary: 'Upsert the current actor’s display settings for one object type',
	request: {
		headers: workspaceIdHeader,
		params: userDisplaySettingsParamsSchema,
		body: { content: { 'application/json': { schema: upsertUserDisplaySettingsBodySchema } } },
	},
	responses: {
		200: {
			description: 'Display settings upserted',
			content: { 'application/json': { schema: userDisplaySettingsResponseSchema } },
		},
	},
})

app.openapi(upsertRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { object_type } = c.req.valid('param')
	const { settings } = c.req.valid('json')

	const rows = await db
		.insert(userDisplaySettings)
		.values({
			workspaceId,
			actorId,
			objectType: object_type,
			name: DEFAULT_NAME,
			settings,
		})
		.onConflictDoUpdate({
			target: [
				userDisplaySettings.workspaceId,
				userDisplaySettings.actorId,
				userDisplaySettings.objectType,
				userDisplaySettings.name,
			],
			set: { settings, updatedAt: new Date() },
		})
		.returning()

	const row = rows[0]
	if (!row) {
		// Upsert with RETURNING should always yield exactly one row. If it
		// didn't, something is very wrong — surface it rather than swallow.
		throw new Error('Upsert returned no row')
	}

	logger.info('upsert user display settings', {
		actorId,
		workspaceId,
		objectType: object_type,
	})

	return c.json(serializeRow(row), 200)
})

export default app
