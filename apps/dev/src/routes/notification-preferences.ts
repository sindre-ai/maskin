import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { type NotificationPreferencesRow, notificationPreferences } from '@maskin/db/schema'
import {
	NOTIFICATION_PREFERENCES_DEFAULTS,
	type NotificationPreferencesResponse,
	notificationPreferencesResponseSchema,
	updateNotificationPreferencesSchema,
} from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { errorSchema } from '../lib/openapi-schemas'
import { resolveAuditWorkspace } from './devices'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

function serialize(row: NotificationPreferencesRow | undefined): NotificationPreferencesResponse {
	const d = NOTIFICATION_PREFERENCES_DEFAULTS
	if (!row) {
		return {
			timezone: d.timezone,
			quiet_hours_start: d.quiet_hours_start,
			quiet_hours_end: d.quiet_hours_end,
			categories: { ...d.categories },
			briefing_enabled: d.briefing_enabled,
			briefing_time: d.briefing_time,
			muted_workspace_ids: [],
			updated_at: null,
		}
	}
	return {
		timezone: row.timezone,
		quiet_hours_start: row.quietHoursStart,
		quiet_hours_end: row.quietHoursEnd,
		categories: { ...d.categories, ...row.categories },
		briefing_enabled: row.briefingEnabled,
		briefing_time: row.briefingTime,
		muted_workspace_ids: row.mutedWorkspaceIds,
		updated_at: row.updatedAt.toISOString(),
	}
}

// GET /api/notification-preferences
const getRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Notification Preferences'],
	summary: 'Get the current actor’s push notification preferences',
	description: 'Per-actor, not per-workspace. Returns defaults (updated_at null) when never saved.',
	responses: {
		200: {
			description: 'Preferences',
			content: { 'application/json': { schema: notificationPreferencesResponseSchema } },
		},
	},
})

app.openapi(getRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const [row] = await db
		.select()
		.from(notificationPreferences)
		.where(eq(notificationPreferences.actorId, actorId))
		.limit(1)
	return c.json(serialize(row), 200)
})

// PUT /api/notification-preferences
const putRoute = createRoute({
	method: 'put',
	path: '/',
	tags: ['Notification Preferences'],
	summary: 'Upsert the current actor’s push notification preferences',
	description:
		'Idempotent upsert. Omitted fields keep their current value (or the default); null clears timezone / quiet hours; categories merges key by key.',
	request: {
		body: { content: { 'application/json': { schema: updateNotificationPreferencesSchema } } },
	},
	responses: {
		200: {
			description: 'Preferences saved',
			content: { 'application/json': { schema: notificationPreferencesResponseSchema } },
		},
		400: {
			description: 'Invalid request',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(putRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const body = c.req.valid('json')

	const [existing] = await db
		.select()
		.from(notificationPreferences)
		.where(eq(notificationPreferences.actorId, actorId))
		.limit(1)
	const current = serialize(existing)

	const now = new Date()
	const values = {
		timezone: body.timezone !== undefined ? body.timezone : current.timezone,
		quietHoursStart:
			body.quiet_hours_start !== undefined ? body.quiet_hours_start : current.quiet_hours_start,
		quietHoursEnd:
			body.quiet_hours_end !== undefined ? body.quiet_hours_end : current.quiet_hours_end,
		categories: { ...current.categories, ...body.categories },
		briefingEnabled: body.briefing_enabled ?? current.briefing_enabled,
		briefingTime: body.briefing_time ?? current.briefing_time,
		mutedWorkspaceIds: [...new Set(body.muted_workspace_ids ?? current.muted_workspace_ids)],
	}

	const [row] = await db
		.insert(notificationPreferences)
		.values({ actorId, ...values, createdAt: now, updatedAt: now })
		.onConflictDoUpdate({
			target: notificationPreferences.actorId,
			set: { ...values, updatedAt: now },
		})
		.returning()

	try {
		const workspaceId = await resolveAuditWorkspace(db, actorId, c.req.header('X-Workspace-Id'))
		if (workspaceId) {
			// Events fan out to every workspace member; record only that it happened.
			await recordEvent(db, {
				workspaceId,
				actorId,
				action: existing ? 'updated' : 'created',
				entityType: 'notification_preferences',
				entityId: actorId,
			})
		}
	} catch (err) {
		logger.warn('notification preferences audit event failed', { error: String(err) })
	}

	return c.json(serialize(row), 200)
})

export default app
