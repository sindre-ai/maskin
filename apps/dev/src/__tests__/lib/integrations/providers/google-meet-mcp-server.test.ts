import type { Database } from '@maskin/db'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveMeetTokenMock } = vi.hoisted(() => ({
	resolveMeetTokenMock: vi.fn(),
}))
vi.mock('../../../../lib/integrations/providers/google-meet/token', () => ({
	resolveMeetToken: resolveMeetTokenMock,
}))

import { createGoogleMeetMcpServer } from '../../../../lib/integrations/providers/google-meet/mcp-server'

interface RegisteredTool {
	handler: (args: unknown, extra: unknown) => Promise<{
		content: Array<{ type: string; text: string }>
		isError?: boolean
	}>
}

function getTool(server: McpServer, name: string): RegisteredTool {
	const tools = (
		server as unknown as {
			_registeredTools: Record<string, RegisteredTool>
		}
	)._registeredTools
	const tool = tools[name]
	if (!tool) throw new Error(`Tool not registered: ${name}`)
	return tool
}

function parseResult(result: { content: Array<{ text: string }> }): unknown {
	return JSON.parse(result.content[0].text)
}

// A minimal Database stub — the create_space idempotency path uses
// `db.select() ... .from(...) ... .limit(1)` for lookup + `db.insert().values().onConflictDoNothing()`
// for record. Same shape for the meeting metadata write (`db.update()...`).
function mockDb(overrides: {
	spaceLookupSequence?: Array<string | null>
	updateFn?: () => Promise<void>
} = {}): Database {
	const lookupQueue = [...(overrides.spaceLookupSequence ?? [])]
	const inserted: unknown[] = []

	const db = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => {
						// A caller with an empty queue always misses; the caller
						// supplies null explicitly to simulate a miss-then-hit
						// (the create_space path: lookup null → provision → lookup hit).
						const spaceName = lookupQueue.length ? lookupQueue.shift() : null
						return spaceName
							? [{ spaceName, createdAt: new Date('2026-09-10T09:00:00Z') }]
							: []
					},
				}),
			}),
		}),
		insert: () => ({
			values: (v: unknown) => {
				inserted.push(v)
				return {
					onConflictDoNothing: async () => undefined,
				}
			},
		}),
		update: () => ({
			set: () => ({
				where: async () => {
					if (overrides.updateFn) await overrides.updateFn()
				},
			}),
		}),
		__inserted: inserted,
	} as unknown as Database
	return db
}

const CTX = {
	workspaceId: 'ws-1',
	actorId: 'actor-1',
}

const OK_TOKEN = {
	accessToken: 'ya29.access-token',
	integrationId: 'int-1',
	resolvedActorId: 'actor-1',
	externalId: 'sebk@meshfirm.com',
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
	resolveMeetTokenMock.mockReset()
	fetchMock = vi.fn()
	vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('google_meet__create_meet_backed_event', () => {
	it('POSTs calendar.events.insert with conferenceDataVersion=1 + a Meet createRequest, and returns {event, meet_uri, meet_space_name}', async () => {
		resolveMeetTokenMock.mockResolvedValue(OK_TOKEN)
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				id: 'evt-1',
				htmlLink: 'https://calendar.google.com/event?eid=evt-1',
				hangoutLink: 'https://meet.google.com/abc-defg-hij',
				summary: 'Acme × Beta demo',
				conferenceData: {
					conferenceId: 'abc-defg-hij',
					conferenceSolution: { key: { type: 'hangoutsMeet' } },
					entryPoints: [
						{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
					],
				},
			}),
			headers: new Headers(),
			text: async () => '',
		} as never)

		const server = createGoogleMeetMcpServer({ db: mockDb(), ...CTX })
		const tool = getTool(server, 'google_meet__create_meet_backed_event')

		const result = await tool.handler(
			{
				summary: 'Acme × Beta demo',
				start: { date_time: '2026-09-11T15:00:00-07:00', time_zone: 'America/Los_Angeles' },
				end: { date_time: '2026-09-11T15:45:00-07:00', time_zone: 'America/Los_Angeles' },
			},
			{},
		)

		expect(fetchMock).toHaveBeenCalledOnce()
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toContain('/calendar/v3/calendars/primary/events?conferenceDataVersion=1')
		expect((init.headers as Record<string, string>).Authorization).toBe(
			'Bearer ya29.access-token',
		)
		const body = JSON.parse(init.body as string)
		expect(body.conferenceData.createRequest.conferenceSolutionKey.type).toBe('hangoutsMeet')
		expect(body.conferenceData.createRequest.requestId).toBeTypeOf('string')
		expect(body.conferenceData.createRequest.requestId.length).toBeGreaterThan(0)

		const payload = parseResult(result) as {
			event: { id: string; hangoutLink: string; conferenceData: { conferenceId: string } }
			meet_uri: string
			meet_space_name: string
		}
		expect(payload.event.id).toBe('evt-1')
		expect(payload.event.hangoutLink).toBe('https://meet.google.com/abc-defg-hij')
		expect(payload.event.conferenceData.conferenceId).toBe('abc-defg-hij')
		expect(payload.meet_uri).toBe('https://meet.google.com/abc-defg-hij')
		expect(payload.meet_space_name).toBe('spaces/abc-defg-hij')
		expect(result.isError).toBeFalsy()
	})

	it('uses the same deterministic request_id on retries with identical inputs — Google replays natively', async () => {
		resolveMeetTokenMock.mockResolvedValue(OK_TOKEN)
		const responseJson = {
			id: 'evt-1',
			hangoutLink: 'https://meet.google.com/abc-defg-hij',
			conferenceData: {
				conferenceId: 'abc-defg-hij',
				entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }],
			},
		}
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => responseJson,
			headers: new Headers(),
			text: async () => '',
		} as never)

		const server = createGoogleMeetMcpServer({ db: mockDb(), ...CTX })
		const tool = getTool(server, 'google_meet__create_meet_backed_event')

		const args = {
			summary: 'Sebk demo',
			start: { date_time: '2026-09-11T15:00:00-07:00', time_zone: 'America/Los_Angeles' },
			end: { date_time: '2026-09-11T15:45:00-07:00', time_zone: 'America/Los_Angeles' },
		}

		await tool.handler(args, {})
		await tool.handler(args, {})

		const first = JSON.parse(
			(fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
		)
		const second = JSON.parse(
			(fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
		)
		expect(first.conferenceData.createRequest.requestId).toBe(
			second.conferenceData.createRequest.requestId,
		)
	})

	it('returns RECONSENT_REQUIRED envelope when the resolver rejects with that code', async () => {
		const { MeetToolError } = await import(
			'../../../../lib/integrations/providers/google-meet/errors'
		)
		resolveMeetTokenMock.mockRejectedValue(
			new MeetToolError('RECONSENT_REQUIRED', 'grant is missing meetings.space.created', {
				hint: 'reconnect',
			}),
		)

		const server = createGoogleMeetMcpServer({ db: mockDb(), ...CTX })
		const tool = getTool(server, 'google_meet__create_meet_backed_event')

		const result = await tool.handler(
			{
				summary: 'x',
				start: { date_time: '2026-09-11T15:00:00-07:00', time_zone: 'UTC' },
				end: { date_time: '2026-09-11T15:30:00-07:00', time_zone: 'UTC' },
			},
			{},
		)

		expect(result.isError).toBe(true)
		const payload = parseResult(result) as {
			error: { code: string; hint: string }
		}
		expect(payload.error.code).toBe('RECONSENT_REQUIRED')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('maps a Google 403 with "workspace" in the reason to MEET_REQUIRES_WORKSPACE', async () => {
		resolveMeetTokenMock.mockResolvedValue(OK_TOKEN)
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 403,
			headers: new Headers(),
			text: async () =>
				JSON.stringify({
					error: {
						code: 403,
						message: 'Meet requires a Google Workspace account',
						status: 'PERMISSION_DENIED',
					},
				}),
			json: async () => ({}),
		} as never)

		const server = createGoogleMeetMcpServer({ db: mockDb(), ...CTX })
		const tool = getTool(server, 'google_meet__create_meet_backed_event')
		const result = await tool.handler(
			{
				summary: 'x',
				start: { date_time: '2026-09-11T15:00:00-07:00', time_zone: 'UTC' },
				end: { date_time: '2026-09-11T15:30:00-07:00', time_zone: 'UTC' },
			},
			{},
		)
		expect(result.isError).toBe(true)
		expect((parseResult(result) as { error: { code: string } }).error.code).toBe(
			'MEET_REQUIRES_WORKSPACE',
		)
	})

	it('sets meeting.metadata.google_meet_space_name when meeting_object_id is provided', async () => {
		resolveMeetTokenMock.mockResolvedValue(OK_TOKEN)
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				id: 'evt-1',
				hangoutLink: 'https://meet.google.com/abc-defg-hij',
				conferenceData: {
					conferenceId: 'abc-defg-hij',
					entryPoints: [
						{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
					],
				},
			}),
			headers: new Headers(),
			text: async () => '',
		} as never)

		let updateCalled = 0
		const server = createGoogleMeetMcpServer({
			db: mockDb({ updateFn: async () => { updateCalled += 1 } }),
			...CTX,
		})
		const tool = getTool(server, 'google_meet__create_meet_backed_event')
		await tool.handler(
			{
				summary: 'x',
				start: { date_time: '2026-09-11T15:00:00-07:00', time_zone: 'UTC' },
				end: { date_time: '2026-09-11T15:30:00-07:00', time_zone: 'UTC' },
				meeting_object_id: '11111111-1111-1111-1111-111111111111',
			},
			{},
		)
		expect(updateCalled).toBe(1)
	})
})

describe('google_meet__create_space', () => {
	it('returns cached space on idempotency hit without hitting Google', async () => {
		resolveMeetTokenMock.mockResolvedValue(OK_TOKEN)

		const server = createGoogleMeetMcpServer({
			db: mockDb({ spaceLookupSequence: ['spaces/xyz-abc-123'] }),
			...CTX,
		})
		const tool = getTool(server, 'google_meet__create_space')
		const result = await tool.handler({ purpose: 'Sebk demo w/ Acme' }, {})

		expect(fetchMock).not.toHaveBeenCalled()
		const payload = parseResult(result) as {
			space_name: string
			meeting_uri: string
			cached: boolean
		}
		expect(payload.space_name).toBe('spaces/xyz-abc-123')
		expect(payload.meeting_uri).toBe('https://meet.google.com/xyz-abc-123')
		expect(payload.cached).toBe(true)
	})

	it('POSTs spaces.create on a miss + returns the fresh space', async () => {
		resolveMeetTokenMock.mockResolvedValue(OK_TOKEN)
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				name: 'spaces/fresh-1',
				meetingUri: 'https://meet.google.com/fresh-abc',
				meetingCode: 'fresh-abc',
				config: { accessType: 'TRUSTED' },
			}),
			headers: new Headers(),
			text: async () => '',
		} as never)

		// db returns [] on the initial lookup, then the record-and-return-existing
		// path does a second lookup that MUST find the row (representing either
		// our winning insert or a racer's). Feed the mock two responses in order:
		// null → miss (triggers spaces.create), then the newly-recorded row.
		const server = createGoogleMeetMcpServer({
			db: mockDb({ spaceLookupSequence: [null, 'spaces/fresh-1'] }),
			...CTX,
		})
		const tool = getTool(server, 'google_meet__create_space')
		const result = await tool.handler(
			{ purpose: 'Acme demo', config: { access_type: 'TRUSTED', moderation: 'ON' } },
			{},
		)

		expect(fetchMock).toHaveBeenCalledOnce()
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://meet.googleapis.com/v2/spaces')
		expect((init.headers as Record<string, string>).Authorization).toBe(
			'Bearer ya29.access-token',
		)
		const body = JSON.parse(init.body as string)
		expect(body.config.accessType).toBe('TRUSTED')
		expect(body.config.moderation).toBe('ON')

		const payload = parseResult(result) as {
			space_name: string
			meeting_uri: string
			cached: boolean
		}
		expect(payload.space_name).toBe('spaces/fresh-1')
		expect(payload.meeting_uri).toBe('https://meet.google.com/fresh-abc')
		expect(payload.cached).toBe(false)
	})

	it('propagates MEET_REQUIRES_WORKSPACE on a Google 403 with "workspace" in the error body', async () => {
		resolveMeetTokenMock.mockResolvedValue(OK_TOKEN)
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 403,
			headers: new Headers(),
			text: async () =>
				JSON.stringify({
					error: {
						code: 403,
						message: 'Meet requires a Google Workspace tier account',
						status: 'PERMISSION_DENIED',
					},
				}),
			json: async () => ({}),
		} as never)

		const server = createGoogleMeetMcpServer({ db: mockDb(), ...CTX })
		const tool = getTool(server, 'google_meet__create_space')
		const result = await tool.handler({ purpose: 'consumer test' }, {})
		expect(result.isError).toBe(true)
		expect((parseResult(result) as { error: { code: string } }).error.code).toBe(
			'MEET_REQUIRES_WORKSPACE',
		)
	})
})
