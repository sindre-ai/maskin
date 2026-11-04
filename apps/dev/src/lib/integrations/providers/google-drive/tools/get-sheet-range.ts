import { type KeyedTokenBucket, createKeyedTokenBucket } from '@maskin/mcp/rate-limit'
import { capturePosthogEvent } from '../../../../analytics/posthog'
import {
	type DocsSheetsToolContext,
	type SheetsMetadata,
	createDefaultDocsSheetsClient,
} from '../docs-sheets-client'
import { DriveError } from '../errors'
import { clampPageSize } from '../operations'
import { getGoogleDriveAccessToken } from '../token'

export const GET_SHEET_RANGE_TOOL = 'google_drive__get_sheet_range'

export const SHEET_PAGE_SIZE_DEFAULT = 1000
export const SHEET_PAGE_SIZE_MAX = 10_000

/**
 * Sheets caps reads at 300 per minute per user per project. The bucket holds a
 * burst of 50 and refills 250 per minute, so any 60 seconds admit at most
 * 50 + 250 = 300 reads per workspace and Google's own 429 never reaches the
 * agent. The bucket is in this process's memory: the budget is per API process,
 * not shared across replicas.
 */
export const SHEETS_READS_PER_MINUTE = 250
export const SHEETS_READ_BURST = 50
export const createSheetsReadBucket = (now?: () => number): KeyedTokenBucket =>
	createKeyedTokenBucket({
		capacity: SHEETS_READ_BURST,
		refillPerWindow: SHEETS_READS_PER_MINUTE,
		windowMs: 60_000,
		now,
	})
const sheetsReadBucket = createSheetsReadBucket()

export interface SheetRangeToolContext extends DocsSheetsToolContext {
	/** Injection point for tests. Defaults to the process-wide per-workspace bucket. */
	rateLimiter?: KeyedTokenBucket
}

export interface GetSheetRangeInput {
	spreadsheetId: string
	range: string
	pageSize?: number
	pageToken?: string
	majorDimension?: 'ROWS' | 'COLUMNS'
}

export interface GetSheetRangeOutput {
	spreadsheetId: string
	range: string
	values: string[][]
	nextPageToken?: string
}

export const GET_SHEET_RANGE_DESCRIPTION =
	"Read a range of cells from a Google Sheet as strings, in the sheet's displayed format. range is A1 notation, e.g. Sheet1!A1:D500, Sheet1!A:D or Sheet1 (named ranges are not supported). Reads are paged by sheet rows: pageSize defaults to 1000 and is capped at 10000. When nextPageToken is present, call again with the same spreadsheetId, range and majorDimension and that token as pageToken; the token is opaque. majorDimension ROWS (default) returns values as a list of rows, COLUMNS as a list of columns; either way a page covers pageSize sheet rows. Trailing empty cells are omitted by Google. Calls are limited to 250 Google reads per minute per workspace; over that you get RATE_LIMIT_EXCEEDED with retry_after_ms."

/**
 * google_drive__get_sheet_range. Google has no paging on values.get, so a page
 * is a window of sheet rows built into the A1 range we send. The first page
 * reads the tab's row count once; the cursor carries it, so every later page is
 * one Google request and the end of the data is decided by the grid, not by a
 * short page (a blank row inside the data must not end the read early).
 */
export async function getSheetRange(
	ctx: SheetRangeToolContext,
	input: GetSheetRangeInput,
): Promise<GetSheetRangeOutput> {
	const majorDimension = input.majorDimension ?? 'ROWS'
	const pageSize = clampPageSize(input.pageSize, SHEET_PAGE_SIZE_DEFAULT, SHEET_PAGE_SIZE_MAX)
	const limiter = ctx.rateLimiter ?? sheetsReadBucket

	const { accessToken } = await getGoogleDriveAccessToken(ctx.db, ctx.workspaceId, ctx.actorId)
	const client = ctx.docsSheetsClient ?? createDefaultDocsSheetsClient()

	let cursor: Cursor
	if (input.pageToken) {
		cursor = decodeCursor(input.pageToken, input.range)
	} else {
		const parsed = parseA1Range(input.range)
		spendRead(limiter, ctx.workspaceId)
		const meta = await client.getSpreadsheetSheets(accessToken, input.spreadsheetId)
		const tab = resolveTab(meta, parsed.sheet)
		const rowCount = tab.gridProperties?.rowCount
		if (rowCount === undefined) {
			throw new DriveError({
				code: 'PROVIDER_ERROR',
				message: 'Google did not report a row count for this sheet tab.',
			})
		}
		cursor = {
			q: input.range,
			s: tab.title as string,
			c1: parsed.c1,
			c2: parsed.c2,
			n: parsed.r1,
			e: Math.min(parsed.r2 ?? rowCount, rowCount),
		}
	}

	let out: GetSheetRangeOutput
	if (cursor.n > cursor.e) {
		// The range starts below the last row of the tab.
		out = { spreadsheetId: input.spreadsheetId, range: input.range, values: [] }
	} else {
		const last = Math.min(cursor.n + pageSize - 1, cursor.e)
		const window = windowRange(cursor, last)
		spendRead(limiter, ctx.workspaceId)
		const res = await client.getSheetValues(
			accessToken,
			input.spreadsheetId,
			window,
			majorDimension,
		)
		out = {
			spreadsheetId: input.spreadsheetId,
			range: res.range ?? window,
			values: res.values ?? [],
		}
		if (last < cursor.e) out.nextPageToken = encodeCursor({ ...cursor, n: last + 1 })
	}

	// Best-effort; counts and flags only, never ids, ranges or cell values.
	void capturePosthogEvent('drive_sheet_read', ctx.actorId, {
		provider: 'google-drive',
		workspace_id: ctx.workspaceId,
		actor_id: ctx.actorId,
		major_dimension: majorDimension,
		outer_count: out.values.length,
		page_size: pageSize,
		paged: Boolean(input.pageToken),
		has_more: Boolean(out.nextPageToken),
	})
	return out
}

function spendRead(limiter: KeyedTokenBucket, workspaceId: string): void {
	const taken = limiter.take(workspaceId)
	if (!taken.allowed) {
		throw new DriveError({
			code: 'RATE_LIMIT_EXCEEDED',
			message: `Sheets reads are limited to ${SHEETS_READS_PER_MINUTE} per minute per workspace to stay under Google's quota. Wait retry_after_ms and call again.`,
			retry_after_ms: taken.retryAfterMs,
		})
	}
}

// --- A1 notation -----------------------------------------------------------

export interface ParsedRange {
	/** Tab name; undefined means the spreadsheet's first tab. */
	sheet?: string
	/** Column letters; both undefined for whole-row ranges and tab-only ranges. */
	c1?: string
	c2?: string
	r1: number
	/** undefined = to the end of the tab. */
	r2?: number
}

const COL = '\\$?([A-Za-z]{1,3})'
const ROW = '\\$?(\\d+)'
const CELL = new RegExp(`^${COL}${ROW}$`)
const CELL_TO_CELL = new RegExp(`^${COL}${ROW}:${COL}${ROW}$`)
const CELL_TO_COL = new RegExp(`^${COL}${ROW}:${COL}$`)
const COL_TO_COL = new RegExp(`^${COL}:${COL}$`)
const ROW_TO_ROW = new RegExp(`^${ROW}:${ROW}$`)
const QUOTED_SHEET = /^'((?:[^']|'')+)'(?:!(.*))?$/

function invalidRange(): DriveError {
	return new DriveError({
		code: 'INVALID_INPUT',
		message:
			'range must be A1 notation such as Sheet1!A1:D500, Sheet1!A:D, Sheet1!1:100 or Sheet1. Named ranges are not supported.',
	})
}

export function parseA1Range(input: string): ParsedRange {
	const text = input.trim()
	let sheet: string | undefined
	let area: string

	const quoted = QUOTED_SHEET.exec(text)
	if (quoted) {
		sheet = (quoted[1] as string).replace(/''/g, "'")
		area = quoted[2] ?? ''
	} else if (text.includes('!')) {
		const bang = text.indexOf('!')
		sheet = text.slice(0, bang)
		area = text.slice(bang + 1)
		if (!sheet) throw invalidRange()
	} else if (isArea(text)) {
		area = text
	} else {
		// No '!' and not an area: the whole tab with that name.
		if (!text) throw invalidRange()
		sheet = text
		area = ''
	}

	const base: ParsedRange = { r1: 1 }
	if (sheet !== undefined) base.sheet = sheet
	if (area === '') return base

	const cell = CELL.exec(area)
	const cellToCell = CELL_TO_CELL.exec(area)
	const cellToCol = CELL_TO_COL.exec(area)
	const colToCol = COL_TO_COL.exec(area)
	const rowToRow = ROW_TO_ROW.exec(area)
	let parsed: ParsedRange | undefined
	if (cell) {
		const row = Number(cell[2])
		parsed = { ...base, c1: upper(cell[1]), c2: upper(cell[1]), r1: row, r2: row }
	} else if (cellToCell) {
		parsed = {
			...base,
			c1: upper(cellToCell[1]),
			c2: upper(cellToCell[3]),
			r1: Number(cellToCell[2]),
			r2: Number(cellToCell[4]),
		}
	} else if (cellToCol) {
		parsed = {
			...base,
			c1: upper(cellToCol[1]),
			c2: upper(cellToCol[3]),
			r1: Number(cellToCol[2]),
		}
	} else if (colToCol) {
		parsed = { ...base, c1: upper(colToCol[1]), c2: upper(colToCol[2]) }
	} else if (rowToRow) {
		parsed = { ...base, r1: Number(rowToRow[1]), r2: Number(rowToRow[2]) }
	}
	if (!parsed || parsed.r1 < 1 || (parsed.r2 !== undefined && parsed.r2 < parsed.r1)) {
		throw invalidRange()
	}
	return parsed
}

function isArea(text: string): boolean {
	return [CELL, CELL_TO_CELL, CELL_TO_COL, COL_TO_COL, ROW_TO_ROW].some((re) => re.test(text))
}

function upper(s: string | undefined): string {
	return (s ?? '').toUpperCase()
}

function resolveTab(meta: SheetsMetadata, name: string | undefined) {
	const tabs = (meta.sheets ?? []).map((s) => s.properties ?? {}).filter((p) => p.title)
	if (name === undefined) {
		const first = tabs[0]
		if (!first) {
			throw new DriveError({ code: 'INVALID_INPUT', message: 'This spreadsheet has no tabs.' })
		}
		return first
	}
	const found =
		tabs.find((t) => t.title === name) ??
		tabs.find((t) => (t.title as string).toLowerCase() === name.toLowerCase())
	if (!found) {
		throw new DriveError({
			code: 'INVALID_INPUT',
			message: `No tab named "${name}" in this spreadsheet. Tabs: ${tabs
				.slice(0, 20)
				.map((t) => `"${t.title}"`)
				.join(', ')}.`,
		})
	}
	return found
}

// --- Page cursor -----------------------------------------------------------

/** What an opaque pageToken carries: the resolved window plan and where to resume. */
interface Cursor {
	/** The range the caller asked for; a token only works with the range it came from. */
	q: string
	/** Resolved tab title. */
	s: string
	c1?: string
	c2?: string
	/** Next row to read. */
	n: number
	/** Last row to read (already clamped to the tab's row count). */
	e: number
}

function windowRange(cursor: Cursor, last: number): string {
	const tab = `'${cursor.s.replace(/'/g, "''")}'`
	return cursor.c1 && cursor.c2
		? `${tab}!${cursor.c1}${cursor.n}:${cursor.c2}${last}`
		: `${tab}!${cursor.n}:${last}`
}

function encodeCursor(cursor: Cursor): string {
	return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(token: string, range: string): Cursor {
	const bad = () =>
		new DriveError({
			code: 'INVALID_INPUT',
			message:
				'pageToken is not valid for this range. Use the nextPageToken from the previous page.',
		})
	let raw: Partial<Cursor>
	try {
		raw = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
	} catch {
		throw bad()
	}
	const isRow = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1
	const isCol = (v: unknown) => v === undefined || (typeof v === 'string' && /^[A-Z]{1,3}$/.test(v))
	if (
		!raw ||
		raw.q !== range ||
		typeof raw.s !== 'string' ||
		!isRow(raw.n) ||
		!isRow(raw.e) ||
		!isCol(raw.c1) ||
		!isCol(raw.c2)
	) {
		throw bad()
	}
	return raw as Cursor
}
