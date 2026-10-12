import { createKeyedTokenBucket } from '@maskin/mcp/rate-limit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import sheetsCassette from './cassettes/sheets-range.json'
import { replayDocsSheetsCassette } from './docs-sheets-cassette'

vi.mock('../../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const getToken = vi.fn()
vi.mock('../../../../../lib/integrations/providers/google-drive/token', () => ({
	getGoogleDriveAccessToken: (...args: unknown[]) => getToken(...args),
}))

const capture = vi.fn()
vi.mock('../../../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: (...args: unknown[]) => capture(...args),
}))

import type { DocsSheetsClient } from '../../../../../lib/integrations/providers/google-drive/docs-sheets-client'
import {
	getSheetRange,
	parseA1Range,
} from '../../../../../lib/integrations/providers/google-drive/tools/get-sheet-range'

const ctx = { db: {} as never, workspaceId: 'ws-1', actorId: 'actor-1' }

beforeEach(() => {
	getToken.mockReset().mockResolvedValue({ accessToken: 'tok', integrationId: 'int-1' })
	capture.mockReset()
})
afterEach(() => vi.restoreAllMocks())

/** A limiter with room for everything, so cassette tests are not about the budget. */
const roomy = () => createKeyedTokenBucket({ capacity: 250, windowMs: 60_000, now: () => 0 })

describe('parseA1Range', () => {
	it.each([
		['Sheet1!A1:D500', { sheet: 'Sheet1', c1: 'A', c2: 'D', r1: 1, r2: 500 }],
		['Sheet1!A:C', { sheet: 'Sheet1', c1: 'A', c2: 'C', r1: 1 }],
		['Sheet1!a5:c', { sheet: 'Sheet1', c1: 'A', c2: 'C', r1: 5 }],
		['Sheet1!2:10', { sheet: 'Sheet1', r1: 2, r2: 10 }],
		['Sheet1', { sheet: 'Sheet1', r1: 1 }],
		["'My Tab'!B2", { sheet: 'My Tab', c1: 'B', c2: 'B', r1: 2, r2: 2 }],
		["'Bob''s Tab'", { sheet: "Bob's Tab", r1: 1 }],
		['A1:B2', { c1: 'A', c2: 'B', r1: 1, r2: 2 }],
		['B7', { c1: 'B', c2: 'B', r1: 7, r2: 7 }],
		['$A$1:$B$2', { c1: 'A', c2: 'B', r1: 1, r2: 2 }],
	])('parses %s', (input, expected) => {
		expect(parseA1Range(input)).toEqual(expected)
	})

	it.each(['', 'Sheet1!A0:B2', 'Sheet1!B5:A2', 'Sheet1!A1:', 'Sheet1!!A1', '!A1'])(
		'rejects %j as INVALID_INPUT',
		(input) => {
			let err: unknown
			try {
				parseA1Range(input)
			} catch (e) {
				err = e
			}
			expect(err).toMatchObject({ code: 'INVALID_INPUT' })
		},
	)
})

describe('getSheetRange paging (cassette)', () => {
	it('slides an A1 window per page; a short page does not end the read, the grid does', async () => {
		const fetchSpy = replayDocsSheetsCassette(sheetsCassette)
		const base = { spreadsheetId: 'sheet-kpi', range: 'Data!A1:B5', pageSize: 2 }
		const c = { ...ctx, rateLimiter: roomy() }

		const p1 = await getSheetRange(c, base)
		expect(p1.range).toBe('Data!A1:B2')
		expect(p1.values).toEqual([
			['date', 'clicks'],
			['2026-10-01', '1,204'],
		])
		expect(p1.nextPageToken).toEqual(expect.any(String))

		// Google trimmed the blank row 4, so this page has 1 row against pageSize 2.
		const p2 = await getSheetRange(c, { ...base, pageToken: p1.nextPageToken })
		expect(p2.values).toEqual([['2026-10-02', '1,310']])
		expect(p2.nextPageToken).toEqual(expect.any(String))

		const p3 = await getSheetRange(c, { ...base, pageToken: p2.nextPageToken })
		expect(p3.values).toEqual([])
		expect(p3.nextPageToken).toBeUndefined()

		// One tab-metadata read on the first page, then one values read per page.
		const paths = fetchSpy.mock.calls.map((call) =>
			decodeURIComponent(new URL(String(call[0])).pathname),
		)
		expect(paths).toEqual([
			'/v4/spreadsheets/sheet-kpi',
			"/v4/spreadsheets/sheet-kpi/values/'Data'!A1:B2",
			"/v4/spreadsheets/sheet-kpi/values/'Data'!A3:B4",
			"/v4/spreadsheets/sheet-kpi/values/'Data'!A5:B5",
		])
	})

	it('defaults pageSize to 1000 and returns everything on one page for a small range', async () => {
		replayDocsSheetsCassette(sheetsCassette)
		const out = await getSheetRange(
			{ ...ctx, rateLimiter: roomy() },
			{ spreadsheetId: 'sheet-kpi', range: 'A1:B2' },
		)
		expect(out.range).toBe('Data!A1:B2')
		expect(out.values).toHaveLength(2)
		expect(out.nextPageToken).toBeUndefined()
	})

	it('sends the bearer token and majorDimension, and passes COLUMNS through', async () => {
		const fetchSpy = replayDocsSheetsCassette(sheetsCassette)
		const out = await getSheetRange(
			{ ...ctx, rateLimiter: roomy() },
			{ spreadsheetId: 'sheet-kpi', range: 'Data!A1:B5', pageSize: 2, majorDimension: 'COLUMNS' },
		)
		expect(out.values).toEqual([
			['date', '2026-10-01'],
			['clicks', '1,204'],
		])
		const [url, init] = fetchSpy.mock.calls[1] as unknown as [string, RequestInit]
		expect(new URL(url).searchParams.get('majorDimension')).toBe('COLUMNS')
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
	})

	it('reads a whole tab by name, quoting a tab name that contains an apostrophe', async () => {
		replayDocsSheetsCassette(sheetsCassette)
		const out = await getSheetRange(
			{ ...ctx, rateLimiter: roomy() },
			{ spreadsheetId: 'sheet-kpi', range: "'Bob''s Tab'" },
		)
		expect(out.values).toEqual([['x'], ['y'], ['z']])
		expect(out.nextPageToken).toBeUndefined()
	})

	it('answers an empty page, without a values read, when the range starts below the last row', async () => {
		const fetchSpy = replayDocsSheetsCassette(sheetsCassette)
		const out = await getSheetRange(
			{ ...ctx, rateLimiter: roomy() },
			{ spreadsheetId: 'sheet-kpi', range: 'Data!A9:B12' },
		)
		expect(out.values).toEqual([])
		expect(out.nextPageToken).toBeUndefined()
		expect(fetchSpy).toHaveBeenCalledTimes(1)
	})

	it('rejects an unknown tab as INVALID_INPUT and names the tabs that exist', async () => {
		const fetchSpy = replayDocsSheetsCassette(sheetsCassette)
		const err = await getSheetRange(
			{ ...ctx, rateLimiter: roomy() },
			{ spreadsheetId: 'sheet-kpi', range: 'Nope!A1:B2' },
		).catch((e) => e)
		expect(err).toMatchObject({ code: 'INVALID_INPUT' })
		expect(err.message).toContain('"Data"')
		expect(fetchSpy).toHaveBeenCalledTimes(1)
	})

	it('maps a missing spreadsheet to FILE_NOT_FOUND', async () => {
		replayDocsSheetsCassette(sheetsCassette)
		await expect(
			getSheetRange(
				{ ...ctx, rateLimiter: roomy() },
				{ spreadsheetId: 'sheet-gone', range: 'Sheet1' },
			),
		).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
		expect(capture).not.toHaveBeenCalled()
	})

	it('rejects a pageToken that is garbage or that came from a different range', async () => {
		const fetchSpy = replayDocsSheetsCassette(sheetsCassette)
		const c = { ...ctx, rateLimiter: roomy() }
		const first = await getSheetRange(c, {
			spreadsheetId: 'sheet-kpi',
			range: 'Data!A1:B5',
			pageSize: 2,
		})
		fetchSpy.mockClear()

		await expect(
			getSheetRange(c, {
				spreadsheetId: 'sheet-kpi',
				range: 'Data!A1:B5',
				pageToken: 'not-a-token',
			}),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' })
		await expect(
			getSheetRange(c, {
				spreadsheetId: 'sheet-kpi',
				range: 'Data!C1:D5',
				pageToken: first.nextPageToken,
			}),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' })
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('emits drive_sheet_read with counts and flags, never ids, ranges or cell values', async () => {
		replayDocsSheetsCassette(sheetsCassette)
		await getSheetRange(
			{ ...ctx, rateLimiter: roomy() },
			{ spreadsheetId: 'sheet-kpi', range: 'Data!A1:B5', pageSize: 2 },
		)

		expect(capture).toHaveBeenCalledTimes(1)
		const [name, actor, props] = capture.mock.calls[0] as [string, string, Record<string, unknown>]
		expect(name).toBe('drive_sheet_read')
		expect(actor).toBe('actor-1')
		expect(props).toMatchObject({
			provider: 'google-drive',
			workspace_id: 'ws-1',
			major_dimension: 'ROWS',
			outer_count: 2,
			page_size: 2,
			paged: false,
			has_more: true,
		})
		const serialized = JSON.stringify(capture.mock.calls)
		expect(serialized).not.toContain('sheet-kpi')
		expect(serialized).not.toContain('Data!')
		expect(serialized).not.toContain('clicks')
	})
})

describe('getSheetRange rate limit (S18)', () => {
	const fakeClient = (): DocsSheetsClient => ({
		getDocument: vi.fn(),
		getSpreadsheetSheets: vi.fn().mockResolvedValue({
			sheets: [{ properties: { title: 'Data', gridProperties: { rowCount: 1_000_000 } } }],
		}),
		getSheetValues: vi.fn().mockResolvedValue({ values: [['x']] }),
	})

	it('answers RATE_LIMIT_EXCEEDED from our surface once the 250-per-minute budget is spent', async () => {
		let now = 0
		const client = fakeClient()
		const c = {
			...ctx,
			docsSheetsClient: client,
			rateLimiter: createKeyedTokenBucket({ capacity: 250, windowMs: 60_000, now: () => now }),
		}
		const input = { spreadsheetId: 's', range: 'Data!A:A', pageSize: 1 }

		// The first page costs two Google reads (tab metadata, then values).
		const first = await getSheetRange(c, input)
		const paged = { ...input, pageToken: first.nextPageToken }

		const outcomes = await Promise.all(
			Array.from({ length: 400 }, () =>
				getSheetRange(c, paged).then(
					() => 'ok' as const,
					(e) => e,
				),
			),
		)

		const allowed = outcomes.filter((o) => o === 'ok')
		const denied = outcomes.filter((o) => o !== 'ok')
		expect(allowed).toHaveLength(248)
		expect(denied).toHaveLength(152)
		for (const e of denied) {
			expect(e).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' })
			expect(e.retryAfterMs).toBeGreaterThan(0)
		}
		// Exactly 250 Google reads were made in the minute, under Google's cap of 300.
		expect(client.getSpreadsheetSheets).toHaveBeenCalledTimes(1)
		expect(client.getSheetValues).toHaveBeenCalledTimes(249)

		// The bucket refills: a minute later the same call goes through.
		now = 60_000
		await expect(getSheetRange(c, paged)).resolves.toMatchObject({ values: [['x']] })
	})

	it('budgets each workspace on its own', async () => {
		const client = fakeClient()
		const limiter = createKeyedTokenBucket({ capacity: 2, windowMs: 60_000, now: () => 0 })
		const input = { spreadsheetId: 's', range: 'Data!A:A', pageSize: 1 }

		await getSheetRange({ ...ctx, docsSheetsClient: client, rateLimiter: limiter }, input)
		await expect(
			getSheetRange({ ...ctx, docsSheetsClient: client, rateLimiter: limiter }, input),
		).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' })
		await expect(
			getSheetRange(
				{ ...ctx, workspaceId: 'ws-2', docsSheetsClient: client, rateLimiter: limiter },
				input,
			),
		).resolves.toMatchObject({ values: [['x']] })
	})
})
