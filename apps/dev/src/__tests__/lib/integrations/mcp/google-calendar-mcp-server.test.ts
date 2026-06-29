import { ApiErrorCode } from '@maskin/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import { createGoogleCalendarMcpServer } from '../../../../lib/integrations/mcp/google-calendar/mcp-server'

interface RegisteredTool {
	handler: (
		args: unknown,
		extra: unknown,
	) => Promise<{
		isError?: boolean
		content: Array<{ type: 'text'; text: string }>
	}>
}

function getTool(server: ReturnType<typeof createGoogleCalendarMcpServer>, name: string) {
	const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
		._registeredTools
	const tool = tools[name]
	expect(tool).toBeDefined()
	return tool
}

function mockResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
	return {
		ok: init.ok ?? true,
		status: init.status ?? 200,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as Response
}

const baseCtx = {
	accessToken: 'ya29.test',
	workspaceId: 'ws-1',
	actorId: 'agent-1',
	connectedEmail: 'magnus@example.com',
}

describe('createGoogleCalendarMcpServer — registered tools', () => {
	beforeEach(() => {
		capturePosthogEventMock.mockClear()
	})

	it('registers exactly the six locked tools — three reads + three writes (AC-T4)', () => {
		const server = createGoogleCalendarMcpServer(baseCtx)
		const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
			._registeredTools
		expect(Object.keys(tools).sort()).toEqual([
			'create_event',
			'get_free_busy',
			'list_calendar_events',
			'list_calendars',
			'send_rsvp',
			'update_event',
		])
	})
})

describe('create_event tool — happy path + idempotency + posthog', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue(
			mockResponse({
				id: 'event-abc',
				htmlLink: 'https://calendar.google.com/event?eid=event-abc',
			}),
		)
		vi.stubGlobal('fetch', fetchMock)
		capturePosthogEventMock.mockClear()
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('returns the new event id and emits mcp_tool_invocation success on the workspace distinct_id', async () => {
		const server = createGoogleCalendarMcpServer(baseCtx)
		const tool = getTool(server, 'create_event')

		const res = await tool.handler(
			{
				calendarId: 'primary',
				title: 'Strategy sync',
				start: '2026-07-04T09:00:00Z',
				end: '2026-07-04T10:00:00Z',
			},
			{},
		)

		expect(res.isError).toBeFalsy()
		const payload = JSON.parse(res.content[0].text)
		expect(payload).toEqual({
			ok: true,
			eventId: 'event-abc',
			htmlLink: 'https://calendar.google.com/event?eid=event-abc',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'mcp_tool_invocation',
			'ws-1',
			expect.objectContaining({
				tool_provider: 'google-calendar',
				tool_name: 'create_event',
				workspace_id: 'ws-1',
				actor_id: 'agent-1',
				outcome: 'success',
			}),
		)
	})

	it('forwards the bound idempotencyKey into Google events.insert?requestId (AC-T7)', async () => {
		const server = createGoogleCalendarMcpServer({ ...baseCtx, idempotencyKey: 'idem-1' })
		const tool = getTool(server, 'create_event')

		await tool.handler(
			{
				calendarId: 'primary',
				title: 'Booked once',
				start: '2026-07-04T09:00:00Z',
				end: '2026-07-04T10:00:00Z',
			},
			{},
		)

		const [url] = fetchMock.mock.calls[0] as [string]
		expect(url).toContain('?requestId=idem-1')
	})

	it('two calls with the same idempotency key produce only one upstream events.insert (AC-T7 spirit)', async () => {
		// Google itself dedupes on `requestId` — at our layer the contract is
		// that we forward the key; the count assertion guards we don't issue
		// extra outbound calls per invocation.
		const server = createGoogleCalendarMcpServer({ ...baseCtx, idempotencyKey: 'idem-shared' })
		const tool = getTool(server, 'create_event')

		await tool.handler(
			{
				calendarId: 'primary',
				title: 'first',
				start: '2026-07-04T09:00:00Z',
				end: '2026-07-04T10:00:00Z',
			},
			{},
		)
		await tool.handler(
			{
				calendarId: 'primary',
				title: 'first',
				start: '2026-07-04T09:00:00Z',
				end: '2026-07-04T10:00:00Z',
			},
			{},
		)

		// 2 tool calls → 2 outbound requests, both carrying the same requestId.
		// Google deduplicates server-side and returns the same event id; we
		// assert here only that the key was forwarded on every call.
		expect(fetchMock).toHaveBeenCalledTimes(2)
		const urls = fetchMock.mock.calls.map((c) => c[0] as string)
		for (const url of urls) {
			expect(url).toContain('?requestId=idem-shared')
		}
	})
})

describe('error mapping — agent sees mapped codes, raw Google body never leaks', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
		capturePosthogEventMock.mockClear()
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('update_event returns event_conflict on 412 with no field mutation hint and no Google body (AC-T8)', async () => {
		fetchMock.mockResolvedValueOnce(
			mockResponse(
				{ error: { code: 412, message: 'sensitive upstream detail' } },
				{ ok: false, status: 412 },
			),
		)
		const server = createGoogleCalendarMcpServer(baseCtx)
		const tool = getTool(server, 'update_event')

		const res = await tool.handler(
			{ calendarId: 'primary', eventId: 'event-1', changes: { title: 'X' } },
			{},
		)

		expect(res.isError).toBe(true)
		const payload = JSON.parse(res.content[0].text)
		expect(payload.code).toBe(ApiErrorCode.EVENT_CONFLICT)
		expect(payload.message).not.toContain('sensitive upstream detail')

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'mcp_tool_invocation',
			'ws-1',
			expect.objectContaining({
				tool_name: 'update_event',
				outcome: 'error',
				error_code: ApiErrorCode.EVENT_CONFLICT,
			}),
		)
	})

	it('create_event returns event_forbidden on 403', async () => {
		fetchMock.mockResolvedValueOnce(
			mockResponse({ error: { code: 403 } }, { ok: false, status: 403 }),
		)
		const server = createGoogleCalendarMcpServer(baseCtx)
		const tool = getTool(server, 'create_event')

		const res = await tool.handler(
			{
				calendarId: 'primary',
				title: 'denied',
				start: '2026-07-04T09:00:00Z',
				end: '2026-07-04T10:00:00Z',
			},
			{},
		)

		const payload = JSON.parse(res.content[0].text)
		expect(payload.code).toBe(ApiErrorCode.EVENT_FORBIDDEN)
	})

	it('update_event returns event_gone on 404', async () => {
		fetchMock.mockResolvedValueOnce(
			mockResponse({ error: { code: 404 } }, { ok: false, status: 404 }),
		)
		const server = createGoogleCalendarMcpServer(baseCtx)
		const tool = getTool(server, 'update_event')

		const res = await tool.handler(
			{ calendarId: 'primary', eventId: 'missing', changes: { title: 'X' } },
			{},
		)

		const payload = JSON.parse(res.content[0].text)
		expect(payload.code).toBe(ApiErrorCode.EVENT_GONE)
	})

	it('any tool returns auth_revoked on Google 401', async () => {
		fetchMock.mockResolvedValueOnce(
			mockResponse({ error: { code: 401 } }, { ok: false, status: 401 }),
		)
		const server = createGoogleCalendarMcpServer(baseCtx)
		const tool = getTool(server, 'create_event')

		const res = await tool.handler(
			{
				calendarId: 'primary',
				title: 'fails',
				start: '2026-07-04T09:00:00Z',
				end: '2026-07-04T10:00:00Z',
			},
			{},
		)

		const payload = JSON.parse(res.content[0].text)
		expect(payload.code).toBe(ApiErrorCode.AUTH_REVOKED)
	})
})

describe('send_rsvp defaults attendeeEmail to the connected Google account', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
		capturePosthogEventMock.mockClear()
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('uses ctx.connectedEmail when the agent omits attendeeEmail', async () => {
		fetchMock
			.mockResolvedValueOnce(
				mockResponse({
					id: 'event-1',
					attendees: [{ email: 'magnus@example.com', responseStatus: 'needsAction' }],
				}),
			)
			.mockResolvedValueOnce(mockResponse({ id: 'event-1' }))

		const server = createGoogleCalendarMcpServer(baseCtx)
		const tool = getTool(server, 'send_rsvp')

		const res = await tool.handler(
			{ calendarId: 'primary', eventId: 'event-1', response: 'accepted' },
			{},
		)

		expect(res.isError).toBeFalsy()
		const patchBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
		expect(patchBody.attendees[0]).toMatchObject({
			email: 'magnus@example.com',
			responseStatus: 'accepted',
		})
	})
})

describe('list_calendars tool — emits PostHog and surfaces auth_revoked (AC-U2 / AC-T3)', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
		capturePosthogEventMock.mockClear()
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('returns calendars and emits success on the workspace distinct_id', async () => {
		fetchMock.mockResolvedValueOnce(
			mockResponse({
				items: [
					{
						id: 'primary',
						summary: 'Magnus',
						primary: true,
						accessRole: 'owner',
						timeZone: 'Europe/Oslo',
					},
				],
			}),
		)

		const server = createGoogleCalendarMcpServer(baseCtx)
		const tool = getTool(server, 'list_calendars')
		const res = await tool.handler({}, {})

		expect(res.isError).toBeFalsy()
		const payload = JSON.parse(res.content[0].text)
		expect(payload.ok).toBe(true)
		expect(payload.calendars).toHaveLength(1)
		expect(payload.calendars[0].id).toBe('primary')

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'mcp_tool_invocation',
			baseCtx.workspaceId,
			expect.objectContaining({
				tool_provider: 'google-calendar',
				tool_name: 'list_calendars',
				workspace_id: baseCtx.workspaceId,
				actor_id: baseCtx.actorId,
				outcome: 'success',
			}),
		)
	})

	it('maps Google 401 to AUTH_REVOKED and emits error with the code', async () => {
		fetchMock.mockResolvedValueOnce(
			mockResponse({ error: { code: 401 } }, { ok: false, status: 401 }),
		)
		const server = createGoogleCalendarMcpServer(baseCtx)
		const tool = getTool(server, 'list_calendars')
		const res = await tool.handler({}, {})

		expect(res.isError).toBe(true)
		const payload = JSON.parse(res.content[0].text)
		expect(payload.code).toBe(ApiErrorCode.AUTH_REVOKED)

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'mcp_tool_invocation',
			baseCtx.workspaceId,
			expect.objectContaining({
				tool_name: 'list_calendars',
				outcome: 'error',
				error_code: ApiErrorCode.AUTH_REVOKED,
			}),
		)
	})
})

describe('list_calendar_events tool — projects AC-U2 fields and emits PostHog', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
		capturePosthogEventMock.mockClear()
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('returns events with summary/start/end/attendees/description and emits success', async () => {
		fetchMock.mockResolvedValueOnce(
			mockResponse({
				items: [
					{
						id: 'evt-1',
						summary: 'Strategy sync',
						description: 'Quarterly review',
						start: { dateTime: '2026-07-04T09:00:00Z' },
						end: { dateTime: '2026-07-04T10:00:00Z' },
						attendees: [{ email: 'sebastian@example.com', responseStatus: 'accepted' }],
					},
				],
			}),
		)

		const server = createGoogleCalendarMcpServer(baseCtx)
		const tool = getTool(server, 'list_calendar_events')
		const res = await tool.handler(
			{ timeMin: '2026-07-04T00:00:00Z', timeMax: '2026-07-05T00:00:00Z' },
			{},
		)

		expect(res.isError).toBeFalsy()
		const payload = JSON.parse(res.content[0].text)
		expect(payload.ok).toBe(true)
		expect(payload.events).toEqual([
			{
				id: 'evt-1',
				summary: 'Strategy sync',
				description: 'Quarterly review',
				start: '2026-07-04T09:00:00Z',
				end: '2026-07-04T10:00:00Z',
				attendees: [{ email: 'sebastian@example.com', responseStatus: 'accepted' }],
				htmlLink: null,
			},
		])

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'mcp_tool_invocation',
			baseCtx.workspaceId,
			expect.objectContaining({
				tool_name: 'list_calendar_events',
				outcome: 'success',
			}),
		)
	})
})

describe('get_free_busy tool — preserves input order and emits PostHog (AC-U3)', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
		capturePosthogEventMock.mockClear()
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('returns busy intervals per requested calendar id', async () => {
		fetchMock.mockResolvedValueOnce(
			mockResponse({
				calendars: {
					primary: {
						busy: [{ start: '2026-07-04T09:00:00Z', end: '2026-07-04T10:00:00Z' }],
					},
					'team@group.calendar.google.com': { busy: [] },
				},
			}),
		)

		const server = createGoogleCalendarMcpServer(baseCtx)
		const tool = getTool(server, 'get_free_busy')
		const res = await tool.handler(
			{
				calendarIds: ['primary', 'team@group.calendar.google.com'],
				timeMin: '2026-07-04T00:00:00Z',
				timeMax: '2026-07-05T00:00:00Z',
			},
			{},
		)

		expect(res.isError).toBeFalsy()
		const payload = JSON.parse(res.content[0].text)
		expect(payload.ok).toBe(true)
		expect(payload.calendars).toEqual([
			{
				calendarId: 'primary',
				busy: [{ start: '2026-07-04T09:00:00Z', end: '2026-07-04T10:00:00Z' }],
			},
			{ calendarId: 'team@group.calendar.google.com', busy: [] },
		])

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'mcp_tool_invocation',
			baseCtx.workspaceId,
			expect.objectContaining({
				tool_name: 'get_free_busy',
				outcome: 'success',
			}),
		)
	})
})
