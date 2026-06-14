import notetakerExtension, {
	NotetakerDispatchPoller,
	__resetActivePollerForTests,
	dispatchToSkjald,
	isInLeadWindow,
	resolveDispatch,
	SkjaldDispatchError,
} from '@maskin/ext-notetaker/server'
import { MEETING_FIELDS, NOTETAKER_DEFAULT_SETTINGS } from '@maskin/ext-notetaker/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestContext } from '../setup'

describe('notetaker extension', () => {
	const meetingType = notetakerExtension.objectTypes.find((t) => t.type === 'meeting')

	it('registers the meeting object type', () => {
		expect(meetingType).toBeDefined()
	})

	it('exposes the M1 fields on the meeting type', () => {
		const fieldNames = meetingType?.defaultFields?.map((f) => f.name) ?? []
		expect(fieldNames).toEqual([
			'meetingUrl',
			'startTime',
			'endTime',
			'language',
			'audioUrl',
			'transcriptUrl',
			'calendarProvider',
			'calendarEventId',
			'skjaldJoin',
			'botName',
			'autoJoin',
		])
	})

	it('mirrors MEETING_FIELDS into defaultSettings.field_definitions.meeting', () => {
		expect(NOTETAKER_DEFAULT_SETTINGS.field_definitions?.meeting).toBe(MEETING_FIELDS)
		expect(notetakerExtension.defaultSettings?.field_definitions?.meeting).toBe(MEETING_FIELDS)
	})

	it('constrains calendarProvider to known values and types booleans for join policy', () => {
		const byName = Object.fromEntries(MEETING_FIELDS.map((f) => [f.name, f]))
		expect(byName.calendarProvider).toMatchObject({ type: 'enum', values: ['google'] })
		expect(byName.skjaldJoin?.type).toBe('boolean')
		expect(byName.autoJoin?.type).toBe('boolean')
	})

	it('exposes a routes(env) factory the app-factory mounts at /api/m/notetaker', () => {
		expect(typeof notetakerExtension.routes).toBe('function')
	})
})

const meeting = (overrides: Partial<Record<string, unknown>> = {}) => ({
	id: overrides.id ?? 'mtg-1',
	title: (overrides.title as string | null | undefined) ?? 'Pricing review',
	status: (overrides.status as string | undefined) ?? 'scheduled',
	metadata: (overrides.metadata as Record<string, unknown> | null | undefined) ?? null,
})

const workspace = (settings: Record<string, unknown> | null = null) => ({
	id: 'ws-1',
	settings,
})

const baseMetadata = (overrides: Record<string, unknown> = {}) => ({
	meetingUrl: 'https://meet.google.com/abc-defg-hij',
	startTime: '2026-06-14T10:00:00Z',
	...overrides,
})

describe('isInLeadWindow', () => {
	const startMs = Date.parse('2026-06-14T10:00:00Z')

	it('returns true inside [startTime - window, startTime + window]', () => {
		expect(isInLeadWindow(startMs, startMs - 30_000, 120_000)).toBe(true)
		expect(isInLeadWindow(startMs, startMs, 120_000)).toBe(true)
		expect(isInLeadWindow(startMs, startMs + 30_000, 120_000)).toBe(true)
	})

	it('returns false outside the window on either side', () => {
		expect(isInLeadWindow(startMs, startMs - 5 * 60_000, 120_000)).toBe(false)
		expect(isInLeadWindow(startMs, startMs + 5 * 60_000, 120_000)).toBe(false)
	})

	it('returns false for undefined or unparseable start times', () => {
		expect(isInLeadWindow(undefined, Date.now(), 120_000)).toBe(false)
		expect(isInLeadWindow(Number.NaN, Date.now(), 120_000)).toBe(false)
	})
})

describe('resolveDispatch', () => {
	const startIso = '2026-06-14T10:00:00Z'
	const startMs = Date.parse(startIso)
	const window = 120_000

	it('skips meetings already carrying a skjaldBotId (dedupe)', () => {
		const m = meeting({ metadata: baseMetadata({ skjaldBotId: 'bot-123' }) })
		const r = resolveDispatch(m, workspace(), startMs, window)
		expect(r).toMatchObject({ dispatch: false, reason: 'already dispatched' })
	})

	it('skips meetings without a meetingUrl', () => {
		const m = meeting({ metadata: { startTime: startIso } })
		const r = resolveDispatch(m, workspace(), startMs, window)
		expect(r.dispatch).toBe(false)
		expect(r.reason).toContain('meetingUrl')
	})

	it('skips meetings outside the lead window', () => {
		const m = meeting({ metadata: baseMetadata() })
		const r = resolveDispatch(m, workspace(), startMs + 10 * 60_000, window)
		expect(r).toMatchObject({ dispatch: false, reason: 'outside lead window' })
	})

	it('per-meeting autoJoin=true overrides everything (incl. workspace=never)', () => {
		const m = meeting({ metadata: baseMetadata({ autoJoin: true }) })
		const ws = workspace({ notetaker: { defaultJoin: { kind: 'never' } } })
		const r = resolveDispatch(m, ws, startMs, window)
		expect(r).toMatchObject({ dispatch: true, reason: 'per-meeting autoJoin=true' })
	})

	it('per-meeting autoJoin=false overrides workspace=all', () => {
		const m = meeting({ metadata: baseMetadata({ autoJoin: false }) })
		const ws = workspace({ notetaker: { defaultJoin: { kind: 'all' } } })
		const r = resolveDispatch(m, ws, startMs, window)
		expect(r).toMatchObject({ dispatch: false, reason: 'per-meeting autoJoin=false' })
	})

	it('falls back to workspace=all by default', () => {
		const m = meeting({ metadata: baseMetadata() })
		const r = resolveDispatch(m, workspace(), startMs, window)
		expect(r.dispatch).toBe(true)
	})

	it('external_only: skips when all attendees are internal', () => {
		const m = meeting({
			metadata: baseMetadata({ attendeeEmails: ['alice@maskin.ai', 'bob@maskin.ai'] }),
		})
		const ws = workspace({
			notetaker: {
				defaultJoin: { kind: 'external_only', workspaceDomains: ['maskin.ai'] },
			},
		})
		expect(resolveDispatch(m, ws, startMs, window).dispatch).toBe(false)
	})

	it('external_only: dispatches when ≥1 attendee is outside the workspace domains', () => {
		const m = meeting({
			metadata: baseMetadata({ attendeeEmails: ['alice@maskin.ai', 'chris@northarc.io'] }),
		})
		const ws = workspace({
			notetaker: {
				defaultJoin: { kind: 'external_only', workspaceDomains: ['maskin.ai'] },
			},
		})
		expect(resolveDispatch(m, ws, startMs, window).dispatch).toBe(true)
	})

	it('pattern: title-include match dispatches; title-exclude skips', () => {
		const ws = workspace({
			notetaker: {
				defaultJoin: { kind: 'pattern', titleIncludes: ['interview'], titleExcludes: ['internal'] },
			},
		})
		expect(
			resolveDispatch(
				meeting({ title: 'Customer Interview — NorthArc', metadata: baseMetadata() }),
				ws,
				startMs,
				window,
			).dispatch,
		).toBe(true)
		expect(
			resolveDispatch(
				meeting({ title: 'Internal sync', metadata: baseMetadata() }),
				ws,
				startMs,
				window,
			).dispatch,
		).toBe(false)
		expect(
			resolveDispatch(
				meeting({ title: 'Random standup', metadata: baseMetadata() }),
				ws,
				startMs,
				window,
			).dispatch,
		).toBe(false)
	})
})

describe('dispatchToSkjald', () => {
	const okResponse = (body: unknown, status = 201) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		})

	it('POSTs to {SKJALD_URL}/api/bots with bearer auth and the spec body', async () => {
		const fetchImpl = vi.fn(async () => okResponse({ id: 'bot-123', status: 'joining' }))
		const res = await dispatchToSkjald(
			{ skjaldUrl: 'https://skjald.test/', apiKey: 'sk-xyz', fetchImpl },
			{
				meetingUrl: 'https://meet.google.com/abc',
				botName: 'Notetaker',
				maskinMeetingId: 'mtg-1',
				maskinWorkspaceId: 'ws-1',
			},
		)
		expect(res).toEqual({ skjaldBotId: 'bot-123', status: 'joining' })
		const [url, init] = fetchImpl.mock.calls[0]
		expect(url).toBe('https://skjald.test/api/bots')
		expect((init as RequestInit).method).toBe('POST')
		const headers = (init as RequestInit).headers as Record<string, string>
		expect(headers.Authorization).toBe('Bearer sk-xyz')
		expect(headers['Content-Type']).toBe('application/json')
		const body = JSON.parse((init as RequestInit).body as string)
		expect(body).toEqual({
			meetingUrl: 'https://meet.google.com/abc',
			botName: 'Notetaker',
			metadata: { maskinMeetingId: 'mtg-1', maskinWorkspaceId: 'ws-1' },
		})
	})

	it('defaults botName to "Notetaker" when none provided', async () => {
		const fetchImpl = vi.fn(async () => okResponse({ id: 'bot-1' }))
		await dispatchToSkjald(
			{ skjaldUrl: 'https://skjald.test', apiKey: 'k', fetchImpl },
			{ meetingUrl: 'u', maskinMeetingId: 'm', maskinWorkspaceId: 'w' },
		)
		const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string)
		expect(body.botName).toBe('Notetaker')
	})

	it('throws SkjaldDispatchError on non-2xx responses', async () => {
		const fetchImpl = vi.fn(async () => new Response('forbidden', { status: 403 }))
		await expect(
			dispatchToSkjald(
				{ skjaldUrl: 'https://skjald.test', apiKey: 'k', fetchImpl },
				{ meetingUrl: 'u', maskinMeetingId: 'm', maskinWorkspaceId: 'w' },
			),
		).rejects.toBeInstanceOf(SkjaldDispatchError)
	})

	it('throws when response JSON is missing `id`', async () => {
		const fetchImpl = vi.fn(async () => okResponse({ status: 'joining' }))
		await expect(
			dispatchToSkjald(
				{ skjaldUrl: 'https://skjald.test', apiKey: 'k', fetchImpl },
				{ meetingUrl: 'u', maskinMeetingId: 'm', maskinWorkspaceId: 'w' },
			),
		).rejects.toThrow(/missing string `id`/)
	})
})

describe('NotetakerDispatchPoller.tick', () => {
	const fakeNow = Date.parse('2026-06-14T10:00:00Z')
	let logEntries: Array<{ level: string; msg: string; ctx?: unknown }>

	function setup(rows: Array<Record<string, unknown>>, wsSettings: Record<string, unknown> | null) {
		const { db, mockResults, calls } = createTestContext()
		// db.select() is called three+ times: (1) the meeting scan, (2..N) one per
		// workspace lookup, (N+1..M) re-reads inside persistDispatch.
		const wsRow = { id: 'ws-1', settings: wsSettings }
		mockResults.selectQueue = [
			rows,
			[wsRow],
			// re-reads happen on dispatch — provide a few in case
			rows,
			rows,
			rows,
		]
		logEntries = []
		return { db, mockResults, calls }
	}

	beforeEach(() => {
		logEntries = []
	})

	it('dispatches a single due meeting and writes skjaldBotId via update.set', async () => {
		const { db, calls } = setup(
			[
				{
					id: 'mtg-1',
					workspaceId: 'ws-1',
					title: 'Pricing review',
					status: 'scheduled',
					metadata: {
						meetingUrl: 'https://meet.google.com/abc-defg-hij',
						startTime: '2026-06-14T10:00:00Z',
					},
				},
			],
			null,
		)
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ id: 'bot-42', status: 'joining' }), { status: 201 }),
		)
		const poller = new NotetakerDispatchPoller(db, {
			skjaldUrl: 'https://skjald.test',
			apiKey: 'sk-xyz',
			fetchImpl,
			now: () => fakeNow,
			log: (level, msg, ctx) => logEntries.push({ level, msg, ctx }),
		})
		const result = await poller.tick()
		expect(result).toMatchObject({ scanned: 1, dispatched: 1, failed: 0, skipped: 0 })
		expect(fetchImpl).toHaveBeenCalledTimes(1)
		// The .set() argument captured by the mock should set status=in_progress and
		// write skjaldBotId without dropping existing metadata fields.
		const lastSet = calls.updates.at(-1) as Record<string, unknown>
		expect(lastSet.status).toBe('in_progress')
		const merged = lastSet.metadata as Record<string, unknown>
		expect(merged.skjaldBotId).toBe('bot-42')
		expect(merged.meetingUrl).toBe('https://meet.google.com/abc-defg-hij')
	})

	it('skips meetings that already carry skjaldBotId — no fetch, no update', async () => {
		const { db, calls } = setup(
			[
				{
					id: 'mtg-1',
					workspaceId: 'ws-1',
					title: 'Already-dispatched',
					status: 'scheduled',
					metadata: {
						meetingUrl: 'https://meet.google.com/abc',
						startTime: '2026-06-14T10:00:00Z',
						skjaldBotId: 'bot-old',
					},
				},
			],
			null,
		)
		const fetchImpl = vi.fn()
		const poller = new NotetakerDispatchPoller(db, {
			skjaldUrl: 'https://skjald.test',
			apiKey: 'k',
			fetchImpl,
			now: () => fakeNow,
			log: (level, msg, ctx) => logEntries.push({ level, msg, ctx }),
		})
		const result = await poller.tick()
		expect(result).toMatchObject({ scanned: 1, dispatched: 0, skipped: 1 })
		expect(fetchImpl).not.toHaveBeenCalled()
		expect(calls.updates).toHaveLength(0)
	})

	it('records the meeting as failed when Skjald returns non-2xx and does not flip status', async () => {
		const { db, calls } = setup(
			[
				{
					id: 'mtg-1',
					workspaceId: 'ws-1',
					title: 'Pricing review',
					status: 'scheduled',
					metadata: {
						meetingUrl: 'https://meet.google.com/abc',
						startTime: '2026-06-14T10:00:00Z',
					},
				},
			],
			null,
		)
		const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 }))
		const poller = new NotetakerDispatchPoller(db, {
			skjaldUrl: 'https://skjald.test',
			apiKey: 'k',
			fetchImpl,
			now: () => fakeNow,
			log: (level, msg, ctx) => logEntries.push({ level, msg, ctx }),
		})
		const result = await poller.tick()
		expect(result).toMatchObject({ scanned: 1, dispatched: 0, failed: 1 })
		expect(calls.updates).toHaveLength(0)
		expect(logEntries.some((e) => e.level === 'error' && e.msg.includes('dispatch failed'))).toBe(
			true,
		)
	})

	it('respects per-meeting autoJoin=false even when workspace policy=all', async () => {
		const { db, calls } = setup(
			[
				{
					id: 'mtg-1',
					workspaceId: 'ws-1',
					title: 'Optional review',
					status: 'scheduled',
					metadata: {
						meetingUrl: 'https://meet.google.com/abc',
						startTime: '2026-06-14T10:00:00Z',
						autoJoin: false,
					},
				},
			],
			{ notetaker: { defaultJoin: { kind: 'all' } } },
		)
		const fetchImpl = vi.fn()
		const poller = new NotetakerDispatchPoller(db, {
			skjaldUrl: 'https://skjald.test',
			apiKey: 'k',
			fetchImpl,
			now: () => fakeNow,
			log: (level, msg, ctx) => logEntries.push({ level, msg, ctx }),
		})
		const result = await poller.tick()
		expect(result).toMatchObject({ scanned: 1, dispatched: 0, skipped: 1 })
		expect(fetchImpl).not.toHaveBeenCalled()
		expect(calls.updates).toHaveLength(0)
	})

	it('emits a success log line with meetingId, workspaceId, and skjaldBotId', async () => {
		const { db } = setup(
			[
				{
					id: 'mtg-9',
					workspaceId: 'ws-1',
					title: 'Pricing review',
					status: 'scheduled',
					metadata: {
						meetingUrl: 'https://meet.google.com/abc',
						startTime: '2026-06-14T10:00:00Z',
					},
				},
			],
			null,
		)
		const fetchImpl = vi.fn(
			async () => new Response(JSON.stringify({ id: 'bot-9', status: 'joining' }), { status: 201 }),
		)
		const poller = new NotetakerDispatchPoller(db, {
			skjaldUrl: 'https://skjald.test',
			apiKey: 'k',
			fetchImpl,
			now: () => fakeNow,
			log: (level, msg, ctx) => logEntries.push({ level, msg, ctx }),
		})
		await poller.tick()
		const successLog = logEntries.find((e) => e.msg === 'Notetaker dispatched meeting')
		expect(successLog).toBeDefined()
		expect(successLog?.ctx).toMatchObject({
			meetingId: 'mtg-9',
			workspaceId: 'ws-1',
			skjaldBotId: 'bot-9',
		})
	})
})

describe('notetakerExtension.routes(env) — feature-flag gating', () => {
	let originalEnv: Record<string, string | undefined>

	beforeEach(() => {
		originalEnv = {
			NOTETAKER_POLLER_ENABLED: process.env.NOTETAKER_POLLER_ENABLED,
			SKJALD_URL: process.env.SKJALD_URL,
			SKJALD_API_KEY: process.env.SKJALD_API_KEY,
		}
		__resetActivePollerForTests()
	})

	afterEach(() => {
		for (const [k, v] of Object.entries(originalEnv)) {
			if (v === undefined) {
				delete process.env[k]
			} else {
				process.env[k] = v
			}
		}
		__resetActivePollerForTests()
	})

	it('returns a healthcheck-only app when poller is disabled', async () => {
		// biome-ignore lint/performance/noDelete: test needs to clear the env var
		delete process.env.NOTETAKER_POLLER_ENABLED
		const { db } = createTestContext()
		const app = notetakerExtension.routes?.({
			db,
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub for the env contract
			notifyBridge: {} as any,
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub for the env contract
			sessionManager: {} as any,
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub for the env contract
			agentStorage: {} as any,
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub for the env contract
			storageProvider: {} as any,
		})
		expect(app).toBeDefined()
		const res = await app?.request('/health')
		expect(res?.status).toBe(200)
		const json = (await res?.json()) as { pollerActive: boolean }
		expect(json.pollerActive).toBe(false)
	})

	it('does NOT start the poller when enabled but SKJALD_URL/SKJALD_API_KEY are missing', async () => {
		process.env.NOTETAKER_POLLER_ENABLED = 'true'
		// biome-ignore lint/performance/noDelete: test needs to clear the env var
		delete process.env.SKJALD_URL
		// biome-ignore lint/performance/noDelete: test needs to clear the env var
		delete process.env.SKJALD_API_KEY
		const { db } = createTestContext()
		const app = notetakerExtension.routes?.({
			db,
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub for the env contract
			notifyBridge: {} as any,
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub for the env contract
			sessionManager: {} as any,
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub for the env contract
			agentStorage: {} as any,
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub for the env contract
			storageProvider: {} as any,
		})
		const res = await app?.request('/health')
		const json = (await res?.json()) as { pollerActive: boolean }
		expect(json.pollerActive).toBe(false)
	})
})
