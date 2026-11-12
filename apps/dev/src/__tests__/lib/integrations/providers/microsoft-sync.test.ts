import type { Database } from '@maskin/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { saveMeeting, track } = vi.hoisted(() => ({
	saveMeeting: vi.fn(async (..._args: unknown[]) => ({
		objectId: 'obj',
		action: 'created' as const,
	})),
	track: vi.fn(async (..._args: unknown[]) => {}),
}))
vi.mock('../../../../lib/integrations/providers/skjald/meeting-sync', () => ({ saveMeeting }))
vi.mock('../../../../lib/analytics/integration-events', () => ({
	trackMeetingTranscriptLanded: track,
}))

const {
	syncMicrosoftIntegration,
	TILE_NOTE_DEFAULT,
	TILE_NOTE_TRANSCRIPTS_OFF,
	meetingExternalId,
} = await import('../../../../lib/integrations/providers/microsoft/sync')

interface SavedMeeting {
	externalId: string
	workspaceId: string
	systemActorId: string
	title: string
	content: string | null
	metadata: (existing: Record<string, unknown> | null) => Record<string, unknown>
}

const NOW = new Date('2026-11-12T12:00:00Z')
const row = () => ({
	id: 'int-1',
	workspaceId: 'ws-1',
	createdBy: 'actor-1',
	config: {} as unknown,
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Ada>Hello there</v>\n'

function event(over: Record<string, unknown> = {}) {
	return {
		id: 'ev-1',
		subject: 'Weekly sync',
		isOnlineMeeting: true,
		onlineMeetingProvider: 'teamsForBusiness',
		onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
		type: 'singleInstance',
		start: { dateTime: '2026-11-12T09:00:00.0000000' },
		end: { dateTime: '2026-11-12T09:30:00.0000000' },
		...over,
	}
}

function fakeDb(landed = false) {
	const updates: unknown[] = []
	const db = {
		select: () => ({
			from: () => ({ where: () => ({ limit: async () => (landed ? [{ id: 'm' }] : []) }) }),
		}),
		update: () => ({ set: (v: unknown) => ({ where: async () => void updates.push(v) }) }),
	} as unknown as Database
	return { db, updates }
}

/** Answers the four Graph calls the job makes, by URL. */
function graphFetch(opts: {
	events?: unknown[]
	meetings?: unknown[]
	transcripts?: unknown[] | Response
	vtt?: string
}) {
	return vi.fn(async (url: string | URL | Request) => {
		const u = String(url)
		if (u.includes('/calendarView')) return json({ value: opts.events ?? [event()] })
		if (u.includes('/onlineMeetings?$filter'))
			return json({ value: opts.meetings ?? [{ id: 'mtg-1' }] })
		if (u.endsWith('/transcripts')) {
			return opts.transcripts instanceof Response
				? opts.transcripts
				: json({
						value: opts.transcripts ?? [{ id: 'tr-1', createdDateTime: '2026-11-12T09:01:00Z' }],
					})
		}
		if (u.includes('/content')) return new Response(opts.vtt ?? VTT)
		throw new Error(`unexpected ${u}`)
	}) as unknown as typeof fetch
}

const run = (db: Database, f: typeof fetch, r = row()) =>
	syncMicrosoftIntegration(db, r, { fetch: f, now: () => NOW, getAccessToken: async () => 'tok' })

describe('syncMicrosoftIntegration', () => {
	beforeEach(() => {
		saveMeeting.mockClear()
		track.mockClear()
	})

	it('lands a finished Teams meeting as one meeting keyed on meeting id and transcript id', async () => {
		const { db } = fakeDb()
		await expect(run(db, graphFetch({}))).resolves.toBe(1)

		expect(saveMeeting).toHaveBeenCalledTimes(1)
		const args = saveMeeting.mock.calls[0][1] as SavedMeeting
		expect(args.externalId).toBe(meetingExternalId('mtg-1', 'tr-1'))
		expect(args.workspaceId).toBe('ws-1')
		expect(args.systemActorId).toBe('actor-1')
		expect(args.title).toBe('Weekly sync')
		expect(args.content).toBe('**Ada:** Hello there')
		expect(args.metadata(null)).toMatchObject({ source: 'microsoft-teams', _ms_event_id: 'ev-1' })
		// Only provider and ok: no title, text or names.
		expect(track).toHaveBeenCalledWith({ provider: 'microsoft', actorId: 'actor-1', ok: true })
	})

	it('writes the same key on a second run, so the upsert updates instead of duplicating', async () => {
		const { db } = fakeDb()
		await run(db, graphFetch({}))
		await run(db, graphFetch({}))
		const keys = saveMeeting.mock.calls.map((c) => (c[1] as { externalId: string }).externalId)
		expect(keys[0]).toBe(keys[1])
	})

	it('skips an event that already landed without calling Graph again', async () => {
		const { db } = fakeDb(true)
		const fetch = graphFetch({})
		await expect(run(db, fetch)).resolves.toBe(0)
		expect(fetch).toHaveBeenCalledTimes(1) // the calendar read only
	})

	it('ignores meetings that have not ended, are not Teams, or are cancelled', async () => {
		const { db } = fakeDb()
		const fetch = graphFetch({
			events: [
				event({ id: 'a', end: { dateTime: '2026-11-12T13:00:00.0000000' } }),
				event({ id: 'b', onlineMeetingProvider: 'skypeForBusiness' }),
				event({ id: 'c', isCancelled: true }),
			],
		})
		await expect(run(db, fetch)).resolves.toBe(0)
		expect(saveMeeting).not.toHaveBeenCalled()
	})

	it('writes nothing for a transcript that has no text yet', async () => {
		const { db } = fakeDb()
		await expect(run(db, graphFetch({ vtt: 'WEBVTT\n\n' }))).resolves.toBe(0)
		expect(saveMeeting).not.toHaveBeenCalled()
	})

	it('keeps only the transcripts that started inside a recurring occurrence', async () => {
		const { db } = fakeDb()
		await run(
			db,
			graphFetch({
				events: [event({ type: 'occurrence' })],
				transcripts: [
					{ id: 'last-week', createdDateTime: '2026-11-05T09:01:00Z' },
					{ id: 'today', createdDateTime: '2026-11-12T09:02:00Z' },
				],
			}),
		)
		expect(saveMeeting).toHaveBeenCalledTimes(1)
		expect((saveMeeting.mock.calls[0][1] as { externalId: string }).externalId).toBe(
			meetingExternalId('mtg-1', 'today'),
		)
	})

	it('shows the IT admin line on the tile when Microsoft answers GraphAccessToTranscriptsDisabled', async () => {
		const { db, updates } = fakeDb()
		const off = json(
			{ error: { code: 'Forbidden', innerError: { code: 'GraphAccessToTranscriptsDisabled' } } },
			403,
		)
		await expect(run(db, graphFetch({ transcripts: off }))).resolves.toBe(0)

		expect(updates).toHaveLength(1)
		expect(JSON.stringify(updates[0])).toContain(TILE_NOTE_TRANSCRIPTS_OFF)
		expect(track).toHaveBeenCalledWith({ provider: 'microsoft', actorId: 'actor-1', ok: false })
	})

	it('does not repeat the write or the event while the admin switch stays off', async () => {
		const { db, updates } = fakeDb()
		const r = { ...row(), config: { status_note: TILE_NOTE_TRANSCRIPTS_OFF } }
		const off = () =>
			json(
				{ error: { code: 'Forbidden', innerError: { code: 'GraphAccessToTranscriptsDisabled' } } },
				403,
			)
		await run(db, graphFetch({ transcripts: off() }), r)
		expect(updates).toHaveLength(0)
		expect(track).not.toHaveBeenCalled()
	})

	it('puts the standing line back once transcripts answer again', async () => {
		const { db, updates } = fakeDb()
		const r = { ...row(), config: { status_note: TILE_NOTE_TRANSCRIPTS_OFF } }
		await run(db, graphFetch({}), r)
		expect(JSON.stringify(updates.at(-1))).toContain(TILE_NOTE_DEFAULT)
	})

	it('carries on with the next event when one fails for another reason', async () => {
		const { db } = fakeDb()
		const fetch = vi.fn(async (url: string | URL | Request) => {
			const u = String(url)
			if (u.includes('/calendarView'))
				return json({
					value: [
						event({ id: 'bad' }),
						event({
							id: 'good',
							onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/xyz' },
						}),
					],
				})
			if (u.includes('abc')) return json({ error: { code: 'NotFound' } }, 404)
			if (u.includes('/onlineMeetings?$filter')) return json({ value: [{ id: 'mtg-2' }] })
			if (u.endsWith('/transcripts')) return json({ value: [{ id: 'tr-9' }] })
			return new Response(VTT)
		}) as unknown as typeof globalThis.fetch
		await expect(run(db, fetch)).resolves.toBe(1)
	})
})
