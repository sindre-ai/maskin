import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { type NotificationPreferencesRow, notificationPreferences } from '@maskin/db/schema'
import {
	NOTIFICATION_PREFERENCES_DEFAULTS,
	type NotificationPreferencesResponse,
	PUSH_CATEGORIES,
	notificationPreferencesResponseSchema,
	resolveBrowserCategories,
	updateNotificationPreferencesSchema,
} from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { errorSchema } from '../lib/openapi-schemas'
import { resolveEmailDigestEnabled, trackEmailSwitchedOff } from '../services/email-preferences'
import { resolveAuditWorkspace } from './devices'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

function serialize(
	row: NotificationPreferencesRow | undefined,
	emailDigestEnabled: boolean,
): NotificationPreferencesResponse {
	const d = NOTIFICATION_PREFERENCES_DEFAULTS
	if (!row) {
		const { browser, notAsked } = resolveBrowserCategories(d.categories, null)
		return {
			timezone: d.timezone,
			quiet_hours_start: d.quiet_hours_start,
			quiet_hours_end: d.quiet_hours_end,
			categories: { ...d.categories },
			browser_categories: browser,
			browser_not_asked: notAsked,
			briefing_enabled: d.briefing_enabled,
			briefing_time: d.briefing_time,
			email_digest_enabled: emailDigestEnabled,
			email_categories: { flow_activity: false },
			marketplace_picks_enabled: false,
			muted_workspace_ids: [],
			updated_at: null,
		}
	}
	const categories = { ...d.categories, ...row.categories }
	const { browser, notAsked } = resolveBrowserCategories(categories, row.browserCategories)
	return {
		timezone: row.timezone,
		quiet_hours_start: row.quietHoursStart,
		quiet_hours_end: row.quietHoursEnd,
		categories,
		browser_categories: browser,
		browser_not_asked: notAsked,
		briefing_enabled: row.briefingEnabled,
		briefing_time: row.briefingTime,
		email_digest_enabled: emailDigestEnabled,
		email_categories: { flow_activity: row.emailCategories?.flow_activity === true },
		marketplace_picks_enabled: row.marketplacePicksEnabled,
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
	const email = await resolveEmailDigestEnabled(db, actorId, row?.emailDigestEnabled)
	return c.json(serialize(row, email), 200)
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
	// Only the push fields are read from `current`; the email state is not needed here.
	const current = serialize(existing, false)

	// A kind never asked about follows its push switch. Changing that push switch must not drag the
	// browser along, so the browser value it had is saved first.
	const browserCategories: Record<string, boolean> = {
		...existing?.browserCategories,
		...body.browser_categories,
	}
	for (const kind of PUSH_CATEGORIES) {
		if (body.categories?.[kind] !== undefined && browserCategories[kind] === undefined) {
			browserCategories[kind] = current.browser_categories[kind]
		}
	}

	const now = new Date()
	const values = {
		timezone: body.timezone !== undefined ? body.timezone : current.timezone,
		quietHoursStart:
			body.quiet_hours_start !== undefined ? body.quiet_hours_start : current.quiet_hours_start,
		quietHoursEnd:
			body.quiet_hours_end !== undefined ? body.quiet_hours_end : current.quiet_hours_end,
		categories: { ...current.categories, ...body.categories },
		browserCategories: Object.keys(browserCategories).length > 0 ? browserCategories : null,
		briefingEnabled: body.briefing_enabled ?? current.briefing_enabled,
		briefingTime: body.briefing_time ?? current.briefing_time,
		mutedWorkspaceIds: [...new Set(body.muted_workspace_ids ?? current.muted_workspace_ids)],
		// Only the kinds sent in this call change; every other kind keeps what is saved.
		...(body.email_categories !== undefined && {
			emailCategories: { ...existing?.emailCategories, ...body.email_categories },
		}),
		// Only a choice sent in this call is saved; an empty choice stays empty.
		...(body.email_digest_enabled !== undefined && {
			emailDigestEnabled: body.email_digest_enabled,
		}),
		...(body.marketplace_picks_enabled !== undefined && {
			marketplacePicksEnabled: body.marketplace_picks_enabled,
		}),
	}

	const [row] = await db
		.insert(notificationPreferences)
		.values({ actorId, ...values, createdAt: now, updatedAt: now })
		.onConflictDoUpdate({
			target: notificationPreferences.actorId,
			set: { ...values, updatedAt: now },
		})
		.returning()

	if (body.email_digest_enabled === false && existing?.emailDigestEnabled !== false) {
		trackEmailSwitchedOff(actorId, 'settings')
	}
	if (body.email_categories?.flow_activity === false && existing?.emailCategories?.flow_activity) {
		trackEmailSwitchedOff(actorId, 'settings', 'flow_activity')
	}

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

	const email = await resolveEmailDigestEnabled(db, actorId, row?.emailDigestEnabled)
	return c.json(serialize(row, email), 200)
})

export default app
