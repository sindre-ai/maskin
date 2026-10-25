import type { Database } from '@maskin/db'
import { integrations, objects } from '@maskin/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { recordEvent } from '../../../events/record-event'
import { isKnowledgeTitleUniqueViolation } from '../../../knowledge-dedup'
import { logger } from '../../../logger'
import { TokenManager } from '../../oauth/token-manager'
import { runIntegrationSync } from '../../sync/runner'
import type { PostInstallContext } from '../../types'
import { inspectIndexStatus } from './index-status'
import { writeSearchDemand } from './search-demand'

export const GSC_PROVIDER = 'google-search-console'

const GSC_API = 'https://www.googleapis.com/webmasters/v3'
const ROW_LIMIT = 25_000
// Safety stop for runaway pagination (100 pages = 2.5M rows per request).
const MAX_PAGES = 100
// Per-property row cap. Rows live in one knowledge object's content and every
// daily sync rewrites it whole, so past this size a sync is not safe to write.
export const MAX_PROPERTY_ROWS = 200_000
// last_error on a property that would pass the cap.
export const TOO_LARGE_ERROR = 'too large'
const BACKFILL_MONTHS = 16
// Search Console only returns final data up to ~2 days ago.
const DATA_LAG_DAYS = 2
// Final data can land later than DATA_LAG_DAYS (the default dataState is final),
// and a day fetched too early comes back empty. Every sync therefore re-fetches
// this many trailing days; mergeRows replaces re-fetched rows by key, so the
// overlap is harmless and a late day is picked up on a later run.
const REFETCH_DAYS = 14
const PERSISTENT_FAILURE_MS = 24 * 60 * 60 * 1000
const MAX_ATTEMPTS = 3
const BASE_BACKOFF_MS = 1_000

/** [date, page url, query, country, device, impressions, clicks, ctr, avg position] */
export type GscRow = [string, string, string, string, string, number, number, number, number]

export const GSC_ROW_COLUMNS = [
	'date',
	'page',
	'query',
	'country',
	'device',
	'impressions',
	'clicks',
	'ctr',
	'avg_position',
] as const

const DIMENSIONS = ['date', 'page', 'query', 'country', 'device']

/** Stored under integrations.config.gsc. */
export interface GscIntegrationState {
	/** Last date (YYYY-MM-DD) every property was synced up to. Set only when a whole run succeeds. */
	lastSyncedDate?: string
	/** Set once the first full run (the 16-month backfill) has succeeded. */
	backfilledAt?: string
	/** ISO time of the first failure in the current streak; cleared on success. */
	firstFailureAt?: string
	lastError?: string
}

type Sleep = (ms: number) => Promise<void>
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── Dates ──────────────────────────────────────────────────────────────────

export function isoDate(date: Date): string {
	return date.toISOString().slice(0, 10)
}

function addDays(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`)
	d.setUTCDate(d.getUTCDate() + days)
	return isoDate(d)
}

/** Newest date with final data. */
export function syncEndDate(now: Date): string {
	return addDays(isoDate(now), -DATA_LAG_DAYS)
}

/** First date of the trailing 16-month window ending at the sync end date. */
export function windowStartDate(now: Date): string {
	const d = new Date(`${syncEndDate(now)}T00:00:00Z`)
	d.setUTCMonth(d.getUTCMonth() - BACKFILL_MONTHS)
	d.setUTCDate(d.getUTCDate() + 1)
	return isoDate(d)
}

/**
 * Date range to fetch for a property, or null when it is already current.
 * Starts REFETCH_DAYS back from the last synced date, not the day after it, so
 * days that were not final yet when first fetched are filled in later.
 */
export function nextRange(
	lastSyncedDate: string | null,
	now: Date,
): { startDate: string; endDate: string } | null {
	const endDate = syncEndDate(now)
	const windowStart = windowStartDate(now)
	const next = lastSyncedDate ? addDays(lastSyncedDate, 1 - REFETCH_DAYS) : windowStart
	const startDate = next < windowStart ? windowStart : next
	return startDate > endDate ? null : { startDate, endDate }
}

// ── Rows ───────────────────────────────────────────────────────────────────

/** Dedupe key: date, page, query, country, device. */
export function rowKey(row: GscRow): string {
	return JSON.stringify(row.slice(0, 5))
}

/**
 * Dedupe on (date, page, query, country, device) within the property's own
 * object. A re-fetched row replaces the stored one in place; rows that fell
 * out of the trailing 16-month window are dropped. written counts the
 * incoming rows that landed in the window, new or replacing.
 */
export function mergeRows(
	existing: GscRow[],
	incoming: GscRow[],
	windowStart: string,
): { rows: GscRow[]; written: number } {
	const byKey = new Map<string, GscRow>()
	for (const row of existing) {
		if (row[0] >= windowStart) byKey.set(rowKey(row), row)
	}
	let written = 0
	for (const row of incoming) {
		if (row[0] < windowStart) continue
		byKey.set(rowKey(row), row)
		written++
	}
	return { rows: [...byKey.values()], written }
}

export function serializeRows(rows: GscRow[]): string {
	return JSON.stringify({ columns: GSC_ROW_COLUMNS, rows })
}

export function parseRows(content: string | null): GscRow[] {
	if (!content) return []
	try {
		const parsed = JSON.parse(content) as { rows?: unknown }
		return Array.isArray(parsed.rows) ? (parsed.rows as GscRow[]) : []
	} catch {
		return []
	}
}

// ── Search Console API ─────────────────────────────────────────────────────

export class GscApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message)
		this.name = 'GscApiError'
	}
}

/** A property's rows would pass MAX_PROPERTY_ROWS. The message is the last_error value. */
export class GscTooLargeError extends Error {
	constructor() {
		super(TOO_LARGE_ERROR)
		this.name = 'GscTooLargeError'
	}
}

function retryDelayMs(res: Response, attempt: number): number {
	const retryAfter = Number(res.headers.get('retry-after'))
	if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000
	return BASE_BACKOFF_MS * 2 ** attempt
}

/** Per-request ceiling, covering the response body too. A hung Google call must not pin the sync. */
export const GSC_FETCH_TIMEOUT_MS = 60_000

/**
 * fetch with a timeout and exponential backoff on 429 and 5xx. Other statuses
 * fail immediately. A timed-out request rejects (TimeoutError) and is not retried.
 */
export async function gscFetch(
	url: string,
	init: RequestInit,
	sleep: Sleep = defaultSleep,
): Promise<Response> {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(url, { signal: AbortSignal.timeout(GSC_FETCH_TIMEOUT_MS), ...init })
		if (res.ok) return res
		const transient = res.status === 429 || res.status >= 500
		if (!transient || attempt >= MAX_ATTEMPTS - 1) {
			const body = await res.text()
			throw new GscApiError(
				res.status,
				`Search Console API HTTP ${res.status}: ${body.slice(0, 300)}`,
			)
		}
		await sleep(retryDelayMs(res, attempt))
	}
}

export async function listSites(accessToken: string, sleep?: Sleep): Promise<string[]> {
	const res = await gscFetch(
		`${GSC_API}/sites`,
		{ headers: { Authorization: `Bearer ${accessToken}` } },
		sleep,
	)
	const body = (await res.json()) as {
		siteEntry?: Array<{ siteUrl: string; permissionLevel: string }>
	}
	return (body.siteEntry ?? [])
		.filter((site) => site.permissionLevel !== 'siteUnverifiedUser')
		.map((site) => site.siteUrl)
}

export async function fetchRows(
	accessToken: string,
	siteUrl: string,
	range: { startDate: string; endDate: string },
	sleep?: Sleep,
): Promise<GscRow[]> {
	const out: GscRow[] = []
	for (let page = 0; page < MAX_PAGES; page++) {
		const res = await gscFetch(
			`${GSC_API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					...range,
					dimensions: DIMENSIONS,
					rowLimit: ROW_LIMIT,
					startRow: page * ROW_LIMIT,
				}),
			},
			sleep,
		)
		const body = (await res.json()) as {
			rows?: Array<{
				keys: string[]
				clicks: number
				impressions: number
				ctr: number
				position: number
			}>
		}
		const rows = body.rows ?? []
		for (const r of rows) {
			const [date = '', pageUrl = '', query = '', country = '', device = ''] = r.keys
			out.push([date, pageUrl, query, country, device, r.impressions, r.clicks, r.ctr, r.position])
		}
		// Rows within one request are unique, so the merged total can only be larger.
		if (out.length > MAX_PROPERTY_ROWS) throw new GscTooLargeError()
		if (rows.length < ROW_LIMIT) return out
	}
	throw new Error(`Search Console returned more than ${MAX_PAGES * ROW_LIMIT} rows for ${siteUrl}`)
}

// ── Knowledge object per property ──────────────────────────────────────────

export function propertyTitle(siteUrl: string): string {
	return `Google Search Console: ${siteUrl}`
}

async function findPropertyObject(db: Database, workspaceId: string, siteUrl: string) {
	const [existing] = await db
		.select({ id: objects.id, content: objects.content, metadata: objects.metadata })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'knowledge'),
				sql`${objects.metadata}->>'provider' = ${GSC_PROVIDER}`,
				sql`${objects.metadata}->>'external_id' = ${siteUrl}`,
			),
		)
		.limit(1)
	return existing ?? null
}

/** Outcome of a property's last read: rows came back, a clean read was empty, or the run errored. */
export type ReadStatus = 'ok' | 'ok_empty' | 'failed'

/** Earliest date that has rows, or undefined when there are none. */
function firstDataDate(rows: GscRow[]): string | undefined {
	let earliest: string | undefined
	for (const row of rows) {
		if (earliest === undefined || row[0] < earliest) earliest = row[0]
	}
	return earliest
}

interface SavePropertyArgs {
	workspaceId: string
	createdBy: string
	integrationId: string
	siteUrl: string
	rows: GscRow[]
	/** Unset only when the very first sync of a property failed, so nothing was synced yet. */
	lastSyncedDate?: string
	/** ISO time of this run's successful read. Left out on a failed run, so no failure time is kept. */
	lastReadOkAt?: string
	windowStart: string
	/** Set on a failed run; a successful save leaves both out, which clears them. */
	failure?: { lastError: string; firstFailureAt: string }
}

/** Insert-or-update the property's knowledge object, matched on metadata external_id (the site URL). */
async function savePropertyObject(db: Database, args: SavePropertyArgs): Promise<void> {
	const { workspaceId, siteUrl, rows } = args
	const readStatus: ReadStatus = args.failure ? 'failed' : rows.length ? 'ok' : 'ok_empty'
	const firstDate = firstDataDate(rows)
	// Scalars only: safeMetadataSchema rejects nested objects, and the standard
	// PATCH route round-trips the whole metadata blob. Rows live in content.
	const metadata = {
		provider: GSC_PROVIDER,
		external_id: siteUrl,
		property_url: siteUrl,
		integration_id: args.integrationId,
		...(args.lastSyncedDate ? { last_synced_date: args.lastSyncedDate } : {}),
		window_start: args.windowStart,
		row_count: rows.length,
		read_status: readStatus,
		...(args.lastReadOkAt ? { last_read_ok_at: args.lastReadOkAt } : {}),
		...(firstDate ? { first_data_date: firstDate } : {}),
		// Data freshness. last_synced_date only says how far the job ran.
		...(rows.length
			? { latest_row_date: rows.reduce((max, r) => (r[0] > max ? r[0] : max), '') }
			: {}),
		...(args.failure
			? { last_error: args.failure.lastError, first_failure_at: args.failure.firstFailureAt }
			: {}),
	}
	const content = serializeRows(rows)
	// No content in the event data: events feed a NOTIFY payload capped at 8KB.
	const audit = (action: 'created' | 'updated', entityId: string) =>
		recordEvent(db, {
			workspaceId,
			actorId: args.createdBy,
			action,
			entityType: 'object',
			entityId,
			data: { type: 'knowledge', provider: GSC_PROVIDER, property_url: siteUrl },
		})
	const update = async (id: string) => {
		await db
			.update(objects)
			.set({ content, metadata, updatedAt: new Date() })
			.where(eq(objects.id, id))
		await audit('updated', id)
	}

	const existing = await findPropertyObject(db, workspaceId, siteUrl)
	if (existing) return update(existing.id)

	try {
		const [created] = await db
			.insert(objects)
			.values({
				workspaceId,
				type: 'knowledge',
				title: propertyTitle(siteUrl),
				content,
				status: 'validated',
				metadata,
				createdBy: args.createdBy,
			})
			.returning({ id: objects.id })
		if (!created) throw new Error('Insert returned no row')
		await audit('created', created.id)
	} catch (err) {
		// A concurrent run created it between the lookup and the insert.
		if (!isKnowledgeTitleUniqueViolation(err)) throw err
		const raced = await findPropertyObject(db, workspaceId, siteUrl)
		if (!raced) throw err
		await update(raced.id)
	}
}

// ── Sync ───────────────────────────────────────────────────────────────────

export interface GscIntegrationRow {
	id: string
	workspaceId: string
	createdBy: string
	status: string
	config: unknown
}

export interface SyncDeps {
	now?: () => Date
	sleep?: Sleep
	getAccessToken?: (db: Database, integrationId: string) => Promise<string>
	/** Replaces the search_demand writeback that follows a completed sync. */
	writeSearchDemand?: typeof writeSearchDemand
	/** Replaces the index-status inspection that follows each integration's sync. */
	inspectIndexStatus?: typeof inspectIndexStatus
}

function gscState(row: GscIntegrationRow): GscIntegrationState {
	return ((row.config as { gsc?: GscIntegrationState } | null)?.gsc ?? {}) as GscIntegrationState
}

async function patchState(
	db: Database,
	row: GscIntegrationRow,
	state: GscIntegrationState,
	status?: 'active' | 'error',
): Promise<void> {
	await db
		.update(integrations)
		.set({
			config: sql`jsonb_set(COALESCE(${integrations.config}, '{}'::jsonb), '{gsc}', ${JSON.stringify(state)}::jsonb, true)`,
			...(status ? { status } : {}),
			updatedAt: new Date(),
		})
		.where(eq(integrations.id, row.id))

	if (status && status !== row.status) {
		await recordEvent(db, {
			workspaceId: row.workspaceId,
			actorId: row.createdBy,
			action: 'updated',
			entityType: 'integration',
			entityId: row.id,
			data: { provider: GSC_PROVIDER, status, last_error: state.lastError ?? null },
		})
	}
}

async function syncProperty(
	db: Database,
	row: GscIntegrationRow,
	siteUrl: string,
	accessToken: string,
	now: Date,
	sleep?: Sleep,
): Promise<number> {
	const existing = await findPropertyObject(db, row.workspaceId, siteUrl)
	const lastSyncedDate =
		(existing?.metadata as { last_synced_date?: string } | null)?.last_synced_date ?? null
	const range = nextRange(lastSyncedDate, now)
	if (!range) return 0

	const incoming = await fetchRows(accessToken, siteUrl, range, sleep)

	const windowStart = windowStartDate(now)
	const { rows, written } = mergeRows(parseRows(existing?.content ?? null), incoming, windowStart)
	// Checked before any write, so the stored rows stay exactly as they were.
	if (rows.length > MAX_PROPERTY_ROWS) throw new GscTooLargeError()
	await savePropertyObject(db, {
		workspaceId: row.workspaceId,
		createdBy: row.createdBy,
		integrationId: row.id,
		siteUrl,
		rows,
		lastSyncedDate: range.endDate,
		lastReadOkAt: now.toISOString(),
		windowStart,
	})
	return written
}

/**
 * Log a failed property run on its own knowledge object: last_error, plus
 * first_failure_at the first time (kept while the streak lasts) and read_status
 * failed. Rows and the other scalars, including last_read_ok_at, stay as they
 * were. A property whose first sync failed gets an empty object so the error
 * has somewhere to live.
 */
async function recordPropertyFailure(
	db: Database,
	row: GscIntegrationRow,
	siteUrl: string,
	message: string,
	now: Date,
): Promise<void> {
	const lastError = message.slice(0, 500)
	const existing = await findPropertyObject(db, row.workspaceId, siteUrl)
	if (!existing) {
		await savePropertyObject(db, {
			workspaceId: row.workspaceId,
			createdBy: row.createdBy,
			integrationId: row.id,
			siteUrl,
			rows: [],
			windowStart: windowStartDate(now),
			failure: { lastError, firstFailureAt: now.toISOString() },
		})
		return
	}
	const firstFailureAt =
		(existing.metadata as { first_failure_at?: string } | null)?.first_failure_at ??
		now.toISOString()
	const patch = {
		last_error: lastError,
		first_failure_at: firstFailureAt,
		read_status: 'failed' satisfies ReadStatus,
	}
	await db
		.update(objects)
		.set({
			metadata: sql`${objects.metadata} || ${JSON.stringify(patch)}::jsonb`,
			updatedAt: new Date(),
		})
		.where(eq(objects.id, existing.id))
	await recordEvent(db, {
		workspaceId: row.workspaceId,
		actorId: row.createdBy,
		action: 'updated',
		entityType: 'object',
		entityId: existing.id,
		data: { type: 'knowledge', provider: GSC_PROVIDER, property_url: siteUrl },
	})
}

const inFlight = new Set<string>()

// Imported lazily: the registry imports this file for the postInstall hook.
async function defaultAccessToken(db: Database, integrationId: string): Promise<string> {
	const { getProvider } = await import('../../registry')
	return new TokenManager().getValidToken(db, integrationId, getProvider(GSC_PROVIDER))
}

/**
 * Sync every property the connected account can see. One property failing does
 * not stop the others; the run then reports as failed so retry, the status
 * surface and integration_sync_completed all see it.
 */
export async function syncGscIntegration(
	db: Database,
	row: GscIntegrationRow,
	deps: SyncDeps = {},
): Promise<{ recordsWritten: number } | null> {
	if (inFlight.has(row.id)) return null
	const now = (deps.now ?? (() => new Date()))()
	const state = gscState(row)
	const endDate = syncEndDate(now)
	const failing = row.status === 'error'
	if (state.lastSyncedDate === endDate && !state.firstFailureAt && !failing) return null

	inFlight.add(row.id)
	try {
		const isBackfill = !state.backfilledAt
		const outcome = await runIntegrationSync(
			{ provider: GSC_PROVIDER, workspaceId: row.workspaceId, isBackfill },
			async () => {
				const accessToken = await (deps.getAccessToken ?? defaultAccessToken)(db, row.id)
				const sites = await listSites(accessToken, deps.sleep)
				let recordsWritten = 0
				const failures: string[] = []
				for (const siteUrl of sites) {
					try {
						recordsWritten += await syncProperty(db, row, siteUrl, accessToken, now, deps.sleep)
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err)
						failures.push(`${siteUrl}: ${message}`)
						logger.error('GSC property sync failed', {
							integrationId: row.id,
							siteUrl,
							error: message,
						})
						// Best effort: a failed write here must not stop the other properties.
						await recordPropertyFailure(db, row, siteUrl, message, now).catch((writeErr) =>
							logger.error('GSC property failure could not be recorded', {
								integrationId: row.id,
								siteUrl,
								error: writeErr instanceof Error ? writeErr.message : String(writeErr),
							}),
						)
					}
				}
				if (failures.length) throw new Error(failures.join('; ').slice(0, 500))
				return { recordsWritten }
			},
		).catch(async (err) => {
			await recordFailure(db, row, state, now, err)
			throw err
		})

		await patchState(
			db,
			row,
			{ lastSyncedDate: endDate, backfilledAt: state.backfilledAt ?? now.toISOString() },
			failing ? 'active' : undefined,
		)
		await writeDemand(db, row, now, deps)
		return outcome
	} finally {
		inFlight.delete(row.id)
	}
}

/**
 * Derive search_demand for the workspace's live content from the freshly
 * synced rows. The sync has already succeeded and been recorded, so a failure
 * here is logged and the next daily run tries again.
 */
async function writeDemand(
	db: Database,
	row: GscIntegrationRow,
	now: Date,
	deps: SyncDeps,
): Promise<void> {
	try {
		await (deps.writeSearchDemand ?? writeSearchDemand)(db, {
			workspaceId: row.workspaceId,
			actorId: row.createdBy,
			now,
		})
	} catch (err) {
		logger.error('GSC search_demand writeback failed', {
			integrationId: row.id,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Remember the failure streak. Past 24 hours the integration flips to status
 * error, which list_integrations and the integrations UI already show.
 */
async function recordFailure(
	db: Database,
	row: GscIntegrationRow,
	state: GscIntegrationState,
	now: Date,
	err: unknown,
): Promise<void> {
	const firstFailureAt = state.firstFailureAt ?? now.toISOString()
	const persistent = now.getTime() - new Date(firstFailureAt).getTime() > PERSISTENT_FAILURE_MS
	await patchState(
		db,
		row,
		{
			...state,
			firstFailureAt,
			lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
		},
		persistent ? 'error' : undefined,
	)
}

/** Run one pass over every connected Search Console integration. Used by the daily scheduler. */
export async function syncAllGscIntegrations(db: Database, deps: SyncDeps = {}): Promise<void> {
	// error rows are included so a recovered integration flips back to active; a
	// postInstall failure also writes error, but those rows carry no gsc state.
	const rows = await db
		.select({
			id: integrations.id,
			workspaceId: integrations.workspaceId,
			createdBy: integrations.createdBy,
			status: integrations.status,
			config: integrations.config,
		})
		.from(integrations)
		.where(
			and(
				eq(integrations.provider, GSC_PROVIDER),
				inArray(integrations.status, ['active', 'error']),
			),
		)

	for (const row of rows) {
		if (row.status === 'error' && !gscState(row).firstFailureAt) continue
		try {
			await syncGscIntegration(db, row, deps)
		} catch {
			// Already logged and recorded per property / in recordFailure; next tick retries.
			// No inspection after a failed sync: the token or the connection may be bad.
			continue
		}
		await inspectIndex(db, row, deps)
	}
}

/**
 * Per-page index status for the integration's tracked pages. Runs after the
 * sync in the same loop, not inside syncGscIntegration (which returns early once
 * the day is synced) and not inside runIntegrationSync (a second
 * integration_sync_completed per run would distort its count). It never changes
 * last_synced_date or the integration status; a failure is logged and the next
 * tick tries again.
 */
async function inspectIndex(db: Database, row: GscIntegrationRow, deps: SyncDeps): Promise<void> {
	try {
		await (deps.inspectIndexStatus ?? inspectIndexStatus)(db, row, {
			now: (deps.now ?? (() => new Date()))(),
			sleep: deps.sleep,
			getAccessToken: () => (deps.getAccessToken ?? defaultAccessToken)(db, row.id),
		})
	} catch (err) {
		logger.error('GSC index inspection failed', {
			integrationId: row.id,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * postInstall hook: start the 16-month backfill without awaiting it, so the
 * OAuth callback redirects immediately. If the detached run fails, the daily
 * scheduler retries it (backfilledAt is still unset).
 */
export async function startGscBackfill(ctx: PostInstallContext): Promise<void> {
	const db = ctx.db as Database
	const [row] = await db
		.select({
			id: integrations.id,
			workspaceId: integrations.workspaceId,
			createdBy: integrations.createdBy,
			status: integrations.status,
			config: integrations.config,
		})
		.from(integrations)
		.where(eq(integrations.id, ctx.integrationId))
		.limit(1)
	if (!row) return

	void syncGscIntegration(db, row).catch((err) => {
		logger.error('GSC backfill failed', {
			integrationId: ctx.integrationId,
			error: err instanceof Error ? err.message : String(err),
		})
	})
}
