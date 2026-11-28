import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { createApiError, validationFailureHook } from '../lib/errors'
import { canRead, resolveAgentAccess } from '../lib/integrations/agent-access'
import { IntegrationAuthRevokedError, ScopeDeniedError } from '../lib/integrations/errors'
import {
	getCredential,
	getIntegrationCredential,
	listActiveIntegrationRows,
} from '../lib/integrations/lookup'
import { TokenManager } from '../lib/integrations/oauth/token-manager'
import {
	CALENDAR_DEFAULT_FUTURE_DAYS,
	CalendarError,
	listCalendars,
	listEvents,
} from '../lib/integrations/providers/google-calendar/calendar'
import { readContextFor } from '../lib/integrations/read-context'
import { getProvider } from '../lib/integrations/registry'
import { accessDeniedMessage } from '../lib/integrations/tool-gate'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'

/**
 * Read the connected Google Calendar through the Calendar API.
 *
 * Behind the google_calendar_list_calendars and google_calendar_list_events MCP tools. Google's
 * hosted Calendar tool server can refuse our sign-in with a 401 while the normal API accepts the
 * same token, so these routes keep agents reading calendars when the hosted tools are down.
 * Read only: nothing here creates or changes an event.
 *
 * Access is the integration grant: "Read" or "Read & write" can read. Several Google accounts can
 * be connected, so a call may name one; without a name the first connected account is used.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const LIST_CALENDARS_TOOL_NAME = 'google_calendar_list_calendars'
const LIST_EVENTS_TOOL_NAME = 'google_calendar_list_events'

const accountSchema = z
	.string()
	.trim()
	.min(3)
	.max(320)
	.optional()
	.describe('Google account email, when several are connected.')

type Fail = {
	status: 400 | 403 | 404 | 409 | 422 | 502
	body: ReturnType<typeof createApiError>
}

const fail = (
	status: Fail['status'],
	code: Parameters<typeof createApiError>[0],
	message: string,
	suggestion?: string,
): Fail => ({ status, body: createApiError(code, message, undefined, suggestion) })

/** The agent named a Google account it cannot use here. The message lists the ones it can. */
class CalendarAccountError extends Error {}

/**
 * A live access token for the caller, and the failure to answer with. The credential is read
 * through Keychain so the read is gated and audited; access is then checked against that row.
 */
async function calendarTokenFor(
	db: Database,
	input: { workspaceId: string; actorId: string; account?: string; toolName: string },
): Promise<{ accessToken: string } | { failure: Fail }> {
	const { workspaceId, actorId, account, toolName } = input
	const ctx = readContextFor(actorId, 'google-calendar:read')

	let credential: Awaited<ReturnType<typeof getCredential>> | null = null
	try {
		if (!account) {
			credential = await getIntegrationCredential(db, workspaceId, 'google-calendar', actorId, {
				fallbackToAnyActor: true,
				ctx,
			})
		} else {
			const rows = await listActiveIntegrationRows(db, workspaceId, 'google-calendar')
			const wanted = account.trim().toLowerCase()
			const chosen = rows.find((r) => r.externalId?.toLowerCase() === wanted)
			// Said the same way for an address that is not connected and one this agent may not use,
			// so the answer does not confirm whose calendar is connected.
			const allowed: string[] = []
			let usable = false
			for (const row of rows) {
				const access = (await resolveAgentAccess(db, workspaceId, row.id, actorId)) ?? 'none'
				if (!canRead(access) || !row.externalId) continue
				allowed.push(row.externalId)
				if (row.id === chosen?.id) usable = true
			}
			if (!chosen || !usable) {
				throw new CalendarAccountError(
					`No Google account ${account} is available to you here. ${
						allowed.length > 0
							? `Accounts you can use: ${allowed.join(', ')}.`
							: 'You have no Google Calendar account you can use for this.'
					}`,
				)
			}
			credential = await getCredential(db, workspaceId, chosen.id, ctx)
		}
	} catch (err) {
		if (err instanceof ScopeDeniedError) {
			return {
				failure: fail(
					403,
					'FORBIDDEN',
					'You do not have access to Google Calendar in this workspace. A workspace admin can grant it under Settings → Integrations.',
				),
			}
		}
		if (err instanceof CalendarAccountError) {
			return { failure: fail(404, 'NOT_FOUND', err.message) }
		}
		throw err
	}
	if (!credential) {
		return {
			failure: fail(
				404,
				'NOT_FOUND',
				'Google Calendar is not connected in this workspace.',
				'Ask a person to connect Google Calendar in Settings → Integrations.',
			),
		}
	}

	const access = (await resolveAgentAccess(db, workspaceId, credential.id, actorId)) ?? 'none'
	if (!canRead(access)) {
		return {
			failure: fail(
				403,
				'FORBIDDEN',
				accessDeniedMessage({
					providerLabel: 'Google Calendar',
					toolName,
					kind: 'read',
					access,
				}),
			),
		}
	}

	try {
		const accessToken = await new TokenManager().getValidToken(
			db,
			credential.id,
			getProvider('google-calendar'),
		)
		return { accessToken }
	} catch (err) {
		if (err instanceof IntegrationAuthRevokedError) {
			return {
				failure: fail(
					409,
					'CONFLICT',
					'Google Calendar cannot be used right now. A person needs to reconnect Google Calendar in Settings → Integrations.',
				),
			}
		}
		throw err
	}
}

function calendarFailureFor(err: CalendarError): Fail {
	switch (err.code) {
		case 'INVALID_INPUT':
			return fail(400, 'BAD_REQUEST', err.message)
		case 'NOT_FOUND':
			return fail(404, 'NOT_FOUND', err.message)
		case 'RECONSENT_REQUIRED':
		case 'INSUFFICIENT_SCOPE':
			return fail(409, 'CONFLICT', err.message)
		case 'REJECTED':
			return fail(422, 'BAD_REQUEST', err.message)
		default:
			return fail(502, 'INTERNAL_ERROR', err.message)
	}
}

const errorResponses = {
	400: { description: 'Invalid', content: { 'application/json': { schema: errorSchema } } },
	403: { description: 'Not allowed', content: { 'application/json': { schema: errorSchema } } },
	404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
	409: { description: 'Conflict', content: { 'application/json': { schema: errorSchema } } },
	422: { description: 'Refused', content: { 'application/json': { schema: errorSchema } } },
	502: { description: 'Calendar error', content: { 'application/json': { schema: errorSchema } } },
}

const calendarsRoute = createRoute({
	method: 'get',
	path: '/calendars',
	tags: ['integrations'],
	summary: 'List calendars through the normal Google Calendar API',
	description:
		'Calendars the connected Google account can see, with id, name, access role, time zone and whether it is the primary one. Needs "Read" or "Read & write" access to Google Calendar.',
	request: {
		headers: workspaceIdHeader,
		query: z.object({ account: accountSchema, page_token: z.string().optional() }),
	},
	responses: {
		200: {
			description: 'Calendars',
			content: {
				'application/json': {
					schema: z.object({
						calendars: z.array(
							z.object({
								calendar_id: z.string(),
								summary: z.string(),
								primary: z.boolean(),
								access_role: z.string(),
								time_zone: z.string().nullable(),
							}),
						),
						next_page_token: z.string().nullable(),
					}),
				},
			},
		},
		...errorResponses,
	},
})

app.openapi(calendarsRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const query = c.req.valid('query')

	const auth = await calendarTokenFor(db, {
		workspaceId,
		actorId,
		account: query.account,
		toolName: LIST_CALENDARS_TOOL_NAME,
	})
	if ('failure' in auth) return c.json(auth.failure.body, auth.failure.status)

	try {
		const result = await listCalendars(auth.accessToken, { pageToken: query.page_token })
		return c.json(result, 200)
	} catch (err) {
		if (!(err instanceof CalendarError)) throw err
		const f = calendarFailureFor(err)
		return c.json(f.body, f.status)
	}
})

const attendeeSchema = z.object({
	email: z.string(),
	name: z.string(),
	response_status: z.string(),
	organizer: z.boolean(),
	self: z.boolean(),
})

const eventSchema = z.object({
	event_id: z.string(),
	calendar_id: z.string(),
	summary: z.string(),
	start: z.string(),
	end: z.string(),
	all_day: z.boolean(),
	location: z.string(),
	organizer: z.object({ email: z.string(), name: z.string(), self: z.boolean() }).nullable(),
	attendees: z.array(attendeeSchema),
	attendee_count: z.number().int(),
	attendees_truncated: z.boolean(),
	self_attending: z.boolean(),
	self_response: z.string().nullable(),
	status: z.string(),
	html_link: z.string().nullable(),
})

const eventsRoute = createRoute({
	method: 'get',
	path: '/events',
	tags: ['integrations'],
	summary: 'List calendar events through the normal Google Calendar API',
	description: `Events in a time window, in start order, with recurring events expanded, through the normal Google Calendar API. Defaults to the next ${CALENDAR_DEFAULT_FUTURE_DAYS} days on the primary calendar. Each event carries summary, start, end, attendees (first 20, with count and whether the calendar owner is on it and their answer), location, organizer, status and link. Needs "Read" or "Read & write" access to Google Calendar.`,
	request: {
		headers: workspaceIdHeader,
		query: z.object({
			account: accountSchema,
			calendar_id: z.string().optional(),
			time_min: z.string().optional(),
			time_max: z.string().optional(),
			max_results: z.coerce.number().int().min(1).max(50).optional(),
			q: z.string().max(200).optional(),
			page_token: z.string().optional(),
		}),
	},
	responses: {
		200: {
			description: 'Events',
			content: {
				'application/json': {
					schema: z.object({
						calendar_id: z.string(),
						time_min: z.string(),
						time_max: z.string(),
						events: z.array(eventSchema),
						next_page_token: z.string().nullable(),
					}),
				},
			},
		},
		...errorResponses,
	},
})

app.openapi(eventsRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const query = c.req.valid('query')

	const auth = await calendarTokenFor(db, {
		workspaceId,
		actorId,
		account: query.account,
		toolName: LIST_EVENTS_TOOL_NAME,
	})
	if ('failure' in auth) return c.json(auth.failure.body, auth.failure.status)

	try {
		const result = await listEvents(auth.accessToken, {
			calendarId: query.calendar_id,
			timeMin: query.time_min,
			timeMax: query.time_max,
			maxResults: query.max_results,
			query: query.q,
			pageToken: query.page_token,
		})
		return c.json(result, 200)
	} catch (err) {
		if (!(err instanceof CalendarError)) throw err
		const f = calendarFailureFor(err)
		return c.json(f.body, f.status)
	}
})

export default app
