import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { integrations, workspaceMembers } from '@maskin/db/schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { insertActor, insertAgentGrant, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const { default: calendarRoutes } = await import('../../routes/integrations-google-calendar')

/**
 * Listing calendars and events through the normal Google Calendar API. Google is stubbed at
 * `fetch` (by URL): this proves our rules (who may read, which account is used, what is refused),
 * not that Google behaves as assumed.
 */

const fetchMock = vi.fn()

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
	fetchMock.mockReset()
	vi.unstubAllGlobals()
})

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})

const CALENDAR_LIST = {
	items: [
		{
			id: 'primary',
			summary: 'Sebastian',
			primary: true,
			accessRole: 'owner',
			timeZone: 'Europe/Copenhagen',
		},
		{ id: 'team@group.calendar.google.com', summary: 'Team', accessRole: 'reader' },
	],
}

const EVENTS = {
	items: [
		{
			id: 'evt1',
			summary: 'Board meeting',
			status: 'confirmed',
			start: { dateTime: '2026-11-28T10:00:00+01:00' },
			end: { dateTime: '2026-11-28T11:00:00+01:00' },
			location: 'HQ',
			organizer: { email: 'sender@example.com', displayName: 'Sebastian', self: true },
			attendees: [
				{
					email: 'sender@example.com',
					displayName: 'Sebastian',
					responseStatus: 'accepted',
					self: true,
					organizer: true,
				},
				{ email: 'anna@northwind.dk', responseStatus: 'needsAction' },
			],
			htmlLink: 'https://calendar.google.com/event?eid=evt1',
		},
		{
			id: 'evt2',
			summary: 'Holiday',
			start: { date: '2026-12-01' },
			end: { date: '2026-12-02' },
		},
	],
	nextPageToken: 'NEXT',
}

/** Answers Google by path and records every call as "METHOD path". */
function stubCalendar() {
	const calls: Array<{ method: string; url: string; token: string }> = []
	fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
		const url = String(input)
		const headers = (init?.headers ?? {}) as Record<string, string>
		calls.push({ method: init?.method ?? 'GET', url, token: headers.Authorization ?? '' })
		const path = url.replace('https://www.googleapis.com/calendar/v3', '')
		if (path.startsWith('/users/me/calendarList')) return json(200, CALENDAR_LIST)
		if (path.startsWith('/calendars/')) return json(200, EVENTS)
		return json(404, { error: { message: 'Not Found' } })
	})
	return calls
}

function appFor(actorId: string) {
	const app = new OpenAPIHono<{ Variables: { db: Database; actorId: string } }>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		await next()
	})
	app.route('/api/integrations/google-calendar', calendarRoutes as never)
	return app
}

type Access = 'read' | 'read_write' | null

async function insertCalendar(
	workspaceId: string,
	agentId: string,
	externalId: string,
	token: string,
	access: Access,
	createdAt?: Date,
) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'google-calendar',
			status: 'active',
			externalId,
			credentials: encrypt(
				JSON.stringify({ accessToken: token, expiresAt: Date.now() + 60 * 60 * 1000 }),
			),
			createdBy: getTestActorId(),
			defaultAgentAccess: 'none' as const,
			...(createdAt ? { createdAt } : {}),
		})
		.returning()
	if (!row) throw new Error('google-calendar integration was not inserted')
	if (access) {
		await insertAgentGrant(db, { workspaceId, integrationId: row.id, actorId: agentId, access })
	}
}

async function setup(accounts: Array<{ address: string; token: string; access: Access }>) {
	const workspace = await insertWorkspace(db, getTestActorId())
	const agent = await insertActor(db, { type: 'agent' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: workspace.id, actorId: agent.id, role: 'member' })
	let day = 1
	for (const a of accounts) {
		await insertCalendar(
			workspace.id,
			agent.id,
			a.address,
			a.token,
			a.access,
			new Date(`2026-01-${String(day++).padStart(2, '0')}`),
		)
	}
	const headers = { 'Content-Type': 'application/json', 'X-Workspace-Id': workspace.id }
	const app = appFor(agent.id)
	return {
		calendars: (query = '') =>
			app.request(`/api/integrations/google-calendar/calendars${query}`, { headers }),
		events: (query = '') =>
			app.request(`/api/integrations/google-calendar/events${query}`, { headers }),
	}
}

const one = (access: Access) => [{ address: 'sender@example.com', token: 'tok-1', access }]

describe('GET /api/integrations/google-calendar/calendars', () => {
	it('lets a read agent list the calendars with id, name and primary flag', async () => {
		const calls = stubCalendar()
		const { calendars } = await setup(one('read'))

		const res = await calendars()

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			calendars: [
				{
					calendar_id: 'primary',
					summary: 'Sebastian',
					primary: true,
					access_role: 'owner',
					time_zone: 'Europe/Copenhagen',
				},
				{
					calendar_id: 'team@group.calendar.google.com',
					summary: 'Team',
					primary: false,
					access_role: 'reader',
					time_zone: null,
				},
			],
			next_page_token: null,
		})
		expect(calls.every((c) => c.method === 'GET')).toBe(true)
		expect(calls[0]?.token).toBe('Bearer tok-1')
	})

	it('refuses an agent with no Google Calendar access and asks Google nothing', async () => {
		const calls = stubCalendar()
		const { calendars } = await setup(one(null))

		const res = await calendars()

		expect(res.status).toBe(403)
		expect(calls).toHaveLength(0)
	})
})

describe('GET /api/integrations/google-calendar/events', () => {
	it('lists events with the fields an agent needs, and whether the owner is attending', async () => {
		const calls = stubCalendar()
		const { events } = await setup(one('read'))

		const res = await events()

		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			calendar_id: string
			events: Array<Record<string, unknown>>
			next_page_token: string | null
		}
		expect(body.calendar_id).toBe('primary')
		expect(body.next_page_token).toBe('NEXT')
		expect(body.events[0]).toMatchObject({
			event_id: 'evt1',
			summary: 'Board meeting',
			start: '2026-11-28T10:00:00+01:00',
			end: '2026-11-28T11:00:00+01:00',
			all_day: false,
			location: 'HQ',
			organizer: { email: 'sender@example.com', name: 'Sebastian', self: true },
			attendee_count: 2,
			attendees_truncated: false,
			self_attending: true,
			self_response: 'accepted',
			status: 'confirmed',
			html_link: 'https://calendar.google.com/event?eid=evt1',
		})
		expect(body.events[0]?.attendees).toEqual([
			{
				email: 'sender@example.com',
				name: 'Sebastian',
				response_status: 'accepted',
				organizer: true,
				self: true,
			},
			{
				email: 'anna@northwind.dk',
				name: '',
				response_status: 'needsAction',
				organizer: false,
				self: false,
			},
		])
		expect(body.events[1]).toMatchObject({
			event_id: 'evt2',
			all_day: true,
			start: '2026-12-01',
			end: '2026-12-02',
			self_attending: false,
			self_response: null,
		})
	})

	it('asks for the next 30 days, in start order, with recurring events expanded', async () => {
		const calls = stubCalendar()
		const { events } = await setup(one('read'))

		await events()

		const url = new URL(calls[0]?.url ?? '')
		expect(url.searchParams.get('singleEvents')).toBe('true')
		expect(url.searchParams.get('orderBy')).toBe('startTime')
		expect(url.searchParams.get('maxResults')).toBe('25')
		const from = new Date(url.searchParams.get('timeMin') ?? '')
		const to = new Date(url.searchParams.get('timeMax') ?? '')
		expect(to.getTime() - from.getTime()).toBe(30 * 86_400_000)
	})

	it('reads the calendar and window it is given', async () => {
		const calls = stubCalendar()
		const { events } = await setup(one('read'))

		const res = await events(
			'?calendar_id=team%40group.calendar.google.com&time_min=2026-12-01T00%3A00%3A00Z&time_max=2026-12-08T00%3A00%3A00Z&max_results=5&q=board',
		)

		expect(res.status).toBe(200)
		const url = new URL(calls[0]?.url ?? '')
		expect(url.pathname).toContain('/calendars/team%40group.calendar.google.com/events')
		expect(url.searchParams.get('timeMin')).toBe('2026-12-01T00:00:00.000Z')
		expect(url.searchParams.get('timeMax')).toBe('2026-12-08T00:00:00.000Z')
		expect(url.searchParams.get('maxResults')).toBe('5')
		expect(url.searchParams.get('q')).toBe('board')
	})

	it('refuses a calendar id that could change the Google URL', async () => {
		const calls = stubCalendar()
		const { events } = await setup(one('read'))

		const res = await events('?calendar_id=..%2F..%2Fusers%2Fme')

		expect(res.status).toBe(400)
		expect(calls).toHaveLength(0)
	})

	it('refuses a time that is not a date', async () => {
		const calls = stubCalendar()
		const { events } = await setup(one('read'))

		const res = await events('?time_min=next%20week')

		expect(res.status).toBe(400)
		expect(calls).toHaveLength(0)
	})

	it('refuses a window that ends before it starts', async () => {
		const calls = stubCalendar()
		const { events } = await setup(one('read'))

		const res = await events('?time_min=2026-12-08T00%3A00%3A00Z&time_max=2026-12-01T00%3A00%3A00Z')

		expect(res.status).toBe(400)
		expect(calls).toHaveLength(0)
	})
})

describe('with several Google accounts', () => {
	const two = (second: Access) => [
		{ address: 'sender@example.com', token: 'tok-first', access: 'read' as const },
		{ address: 'Other@example.com', token: 'tok-second', access: second },
	]

	it('reads the account named in the request, matched without regard to case', async () => {
		const calls = stubCalendar()
		const { events } = await setup(two('read'))

		const res = await events('?account=other%40EXAMPLE.com')

		expect(res.status).toBe(200)
		expect(new Set(calls.map((c) => c.token))).toEqual(new Set(['Bearer tok-second']))
	})

	it('uses the first connected account when none is named', async () => {
		const calls = stubCalendar()
		const { calendars } = await setup(two('read'))

		const res = await calendars()

		expect(res.status).toBe(200)
		expect(new Set(calls.map((c) => c.token))).toEqual(new Set(['Bearer tok-first']))
	})

	it('answers 404 for a named account the agent cannot use, and asks Google nothing', async () => {
		const calls = stubCalendar()
		const { events } = await setup(two(null))

		const res = await events('?account=other@example.com')

		expect(res.status).toBe(404)
		expect(calls).toHaveLength(0)
	})
})
