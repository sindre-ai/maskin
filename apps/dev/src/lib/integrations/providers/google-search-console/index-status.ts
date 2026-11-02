import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { recordEvent } from '../../../events/record-event'
import { isKnowledgeTitleUniqueViolation } from '../../../knowledge-dedup'
import { logger } from '../../../logger'
import { SEARCH_DEMAND_EVENT_SOURCE, demandWindowStart, normalizePageUrl } from './search-demand'
import {
	GSC_PROVIDER,
	GscApiError,
	type GscIntegrationRow,
	gscFetch,
	isoDate,
	parseRows,
} from './sync'

/**
 * Per-page index status from the URL Inspection API. One knowledge object per
 * property, kept apart from the daily sync's rows object: that object's whole
 * metadata is rewritten on every sync, and its lookup (and writeSearchDemand)
 * match on provider google-search-console, which this object must not carry.
 */
// Literals, not GSC_PROVIDER: sync.ts imports this file, so a top-level read of its exports would hit the import cycle.
export const GSC_INDEX_PROVIDER = 'google-search-console-index'
const INSPECT_ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect'
const SC_DOMAIN_PREFIX = 'sc-domain:'
/** Gap between two inspection calls, so a run stays well under the 600 per minute quota. */
export const INSPECT_PACING_MS = 250
/** 15% of Google's 2,000 inspections per property per day, so manual use keeps headroom. */
export const INSPECT_DAILY_CAP = 300
/** A seen-only page is inspected again once this many calendar days have passed. */
export const SEEN_CADENCE_DAYS = 7
/** Rows per index object, well under 2 MB. Seen-only pages are dropped first. */
export const MAX_INDEX_ROWS = 5_000
const ERROR_MAX_LENGTH = 500
const COVERAGE_EVENT_MAX_LENGTH = 200

type Sleep = (ms: number) => Promise<void>
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export type IndexState = 'indexed' | 'canonical_elsewhere' | 'not_indexed' | 'unknown'

/** The fields of Google's indexStatusResult this feature reads. */
export interface IndexStatusResult {
	verdict?: string
	coverageState?: string
	robotsTxtState?: string
	indexingState?: string
	lastCrawlTime?: string
	pageFetchState?: string
	googleCanonical?: string
	userCanonical?: string
}

export const INDEX_ROW_COLUMNS = [
	'url',
	'source',
	'checked_at',
	'state',
	'verdict',
	'coverageState',
	'lastCrawlTime',
	'robotsTxtState',
	'indexingState',
	'pageFetchState',
	'googleCanonical',
	'userCanonical',
	'state_since',
	'error',
] as const

/** One page's latest state. checked_at is an ISO time, state_since a date. */
export interface IndexRow {
	url: string
	source: 'tracked' | 'seen'
	checked_at: string
	state: IndexState
	verdict: string | null
	coverageState: string | null
	lastCrawlTime: string | null
	robotsTxtState: string | null
	indexingState: string | null
	pageFetchState: string | null
	googleCanonical: string | null
	userCanonical: string | null
	state_since: string
	error: string | null
}

// ── Inspect client ─────────────────────────────────────────────────────────

/**
 * Inspect one URL. Reuses gscFetch, so 429 and 5xx back off and retry and the
 * request has a timeout; any other failure throws GscApiError.
 */
export async function inspectUrl(
	accessToken: string,
	siteUrl: string,
	inspectionUrl: string,
	sleep?: Sleep,
): Promise<IndexStatusResult> {
	const res = await gscFetch(
		INSPECT_ENDPOINT,
		{
			method: 'POST',
			headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ inspectionUrl, siteUrl }),
		},
		sleep,
	)
	const body = (await res.json()) as {
		inspectionResult?: { indexStatusResult?: IndexStatusResult }
	}
	const result = body.inspectionResult?.indexStatusResult
	if (!result) throw new Error('Search Console returned no indexStatusResult')
	return result
}

// ── Derived state ──────────────────────────────────────────────────────────

/**
 * indexed: verdict PASS and Google's canonical is absent or the page itself.
 * canonical_elsewhere: verdict PASS but Google chose another URL, so the
 * impressions show under that one. not_indexed: anything else, with
 * coverageState kept as the reason. The mapping is the Architect's reading of
 * the verdict enum, not a rule Google documents.
 */
export function deriveIndexState(url: string, result: IndexStatusResult): IndexState {
	if (result.verdict !== 'PASS') return 'not_indexed'
	const canonical = result.googleCanonical
	if (!canonical || normalizePageUrl(canonical) === normalizePageUrl(url)) return 'indexed'
	return 'canonical_elsewhere'
}

// ── URL to property ────────────────────────────────────────────────────────

/**
 * The property a URL belongs to, or null when none covers it. sc-domain:host
 * covers host and any subdomain, on a dot boundary (notmaskin.io is not
 * maskin.io). A URL-prefix property covers by prefix, so http and https are
 * different properties. A URL several properties cover goes to the sc-domain
 * one, so it is inspected once; among equals the most specific wins.
 */
export function propertyForUrl(url: string, properties: readonly string[]): string | null {
	let target: URL
	try {
		target = new URL(url.trim())
	} catch {
		return null
	}
	if (target.protocol !== 'http:' && target.protocol !== 'https:') return null
	const host = target.hostname.toLowerCase()

	let domainMatch: { property: string; length: number } | null = null
	let prefixMatch: { property: string; length: number } | null = null
	for (const property of properties) {
		if (property.startsWith(SC_DOMAIN_PREFIX)) {
			const domain = property.slice(SC_DOMAIN_PREFIX.length).trim().toLowerCase()
			const covered = domain !== '' && (host === domain || host.endsWith(`.${domain}`))
			if (covered && (!domainMatch || domain.length > domainMatch.length)) {
				domainMatch = { property, length: domain.length }
			}
			continue
		}
		let prefix: URL
		try {
			prefix = new URL(property)
		} catch {
			continue
		}
		const covered = target.href.startsWith(prefix.href) || `${target.href}/` === prefix.href
		if (covered && (!prefixMatch || prefix.href.length > prefixMatch.length)) {
			prefixMatch = { property, length: prefix.href.length }
		}
	}
	return domainMatch?.property ?? prefixMatch?.property ?? null
}

// ── Content ────────────────────────────────────────────────────────────────

export function indexObjectTitle(siteUrl: string): string {
	return `Google Search Console index status: ${siteUrl}`
}

export function serializeIndexRows(rows: IndexRow[]): string {
	return JSON.stringify({
		columns: INDEX_ROW_COLUMNS,
		rows: rows.map((row) => INDEX_ROW_COLUMNS.map((column) => row[column])),
	})
}

export function parseIndexRows(content: string | null): IndexRow[] {
	if (!content) return []
	try {
		const parsed = JSON.parse(content) as { columns?: unknown; rows?: unknown }
		if (!Array.isArray(parsed.columns) || !Array.isArray(parsed.rows)) return []
		const columns = parsed.columns as string[]
		return (parsed.rows as unknown[][]).map(
			(values) =>
				Object.fromEntries(
					columns.map((column, i) => [column, values[i] ?? null]),
				) as unknown as IndexRow,
		)
	} catch {
		return []
	}
}

const dateOf = (isoTime: string): string => isoTime.slice(0, 10)

// ── Knowledge object per property ──────────────────────────────────────────

async function findIndexObject(db: Database, workspaceId: string, siteUrl: string) {
	const [existing] = await db
		.select({ id: objects.id, content: objects.content, metadata: objects.metadata })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'knowledge'),
				sql`${objects.metadata}->>'provider' = ${GSC_INDEX_PROVIDER}`,
				sql`${objects.metadata}->>'external_id' = ${siteUrl}`,
			),
		)
		.limit(1)
	return existing ?? null
}

interface SaveIndexArgs {
	row: GscIntegrationRow
	siteUrl: string
	rows: IndexRow[]
	/** Date of the last run that inspected a page. Unset when none ever did. */
	lastInspectedDate?: string
	inspected: number
	/** ISO time a 429 stopped this run. Left out on a run that did not stop, which clears it. */
	quotaStoppedAt?: string
	/** Set on a failed run or a row-cap drop; a clean save leaves it out, which clears it. */
	lastError?: string
	/** Set with a failed run only; kept while the streak lasts. */
	firstFailureAt?: string
}

/** Insert-or-update the property's index object, matched on provider plus external_id. */
async function saveIndexObject(db: Database, args: SaveIndexArgs): Promise<void> {
	const { row, siteUrl, rows } = args
	const count = (state: IndexState) => rows.filter((r) => r.state === state).length
	// Scalars only: safeMetadataSchema rejects nested objects. Rows live in content.
	const metadata = {
		provider: GSC_INDEX_PROVIDER,
		external_id: siteUrl,
		property_url: siteUrl,
		integration_id: row.id,
		...(args.lastInspectedDate ? { last_inspected_date: args.lastInspectedDate } : {}),
		urls_tracked: rows.filter((r) => r.source === 'tracked').length,
		urls_inspected_last_run: args.inspected,
		indexed_count: count('indexed'),
		canonical_elsewhere_count: count('canonical_elsewhere'),
		not_indexed_count: count('not_indexed'),
		unknown_count: count('unknown'),
		error_count: rows.filter((r) => r.error !== null).length,
		...(args.quotaStoppedAt ? { quota_stopped_at: args.quotaStoppedAt } : {}),
		...(args.lastError ? { last_error: args.lastError } : {}),
		...(args.firstFailureAt ? { first_failure_at: args.firstFailureAt } : {}),
	}
	const content = serializeIndexRows(rows)
	// No content in the event data: events feed a NOTIFY payload capped at 8KB.
	const audit = (action: 'created' | 'updated', entityId: string) =>
		recordEvent(db, {
			workspaceId: row.workspaceId,
			actorId: row.createdBy,
			action,
			entityType: 'object',
			entityId,
			data: { type: 'knowledge', provider: GSC_INDEX_PROVIDER, property_url: siteUrl },
		})
	const update = async (id: string) => {
		await db
			.update(objects)
			.set({ content, metadata, updatedAt: new Date() })
			.where(eq(objects.id, id))
		await audit('updated', id)
	}

	const existing = await findIndexObject(db, row.workspaceId, siteUrl)
	if (existing) return update(existing.id)

	try {
		const [created] = await db
			.insert(objects)
			.values({
				workspaceId: row.workspaceId,
				type: 'knowledge',
				title: indexObjectTitle(siteUrl),
				content,
				status: 'validated',
				metadata,
				createdBy: row.createdBy,
			})
			.returning({ id: objects.id })
		if (!created) throw new Error('Insert returned no row')
		await audit('created', created.id)
	} catch (err) {
		// A concurrent run created it between the lookup and the insert.
		if (!isKnowledgeTitleUniqueViolation(err)) throw err
		const raced = await findIndexObject(db, row.workspaceId, siteUrl)
		if (!raced) throw err
		await update(raced.id)
	}
}

// ── Page lists ─────────────────────────────────────────────────────────────

/** Properties the daily sync keeps a rows object for, for this integration. */
async function listPropertyUrls(db: Database, row: GscIntegrationRow): Promise<string[]> {
	const found = await db
		.select({ siteUrl: sql<string | null>`${objects.metadata}->>'external_id'` })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, row.workspaceId),
				eq(objects.type, 'knowledge'),
				sql`${objects.metadata}->>'provider' = ${GSC_PROVIDER}`,
				sql`${objects.metadata}->>'integration_id' = ${row.id}`,
			),
		)
	return found.flatMap((r) => (r.siteUrl ? [r.siteUrl] : []))
}

/** Canonical URLs of the workspace's live content, one entry per normalized URL. */
async function listTrackedUrls(db: Database, workspaceId: string): Promise<string[]> {
	const found = await db
		.select({ url: sql<string>`btrim(${objects.metadata}->>'canonical_url')` })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'content'),
				eq(objects.status, 'live'),
				sql`btrim(coalesce(${objects.metadata}->>'canonical_url', '')) <> ''`,
			),
		)
	const byKey = new Map<string, string>()
	for (const { url } of found) {
		const key = normalizePageUrl(url)
		if (!byKey.has(key)) byKey.set(key, url)
	}
	return [...byKey.values()]
}

/**
 * Page URLs the property's daily sync saw in the last 30 days, one entry per
 * normalized URL. Only pages that map to this property count: a page a wider
 * property covers is that property's to inspect.
 */
async function listSeenUrls(
	db: Database,
	workspaceId: string,
	siteUrl: string,
	properties: readonly string[],
	now: Date,
): Promise<string[]> {
	const [rowsObject] = await db
		.select({ content: objects.content })
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
	const windowStart = demandWindowStart(now)
	const byKey = new Map<string, string>()
	for (const synced of parseRows(rowsObject?.content ?? null)) {
		const [date, url] = synced
		if (date < windowStart || propertyForUrl(url, properties) !== siteUrl) continue
		const key = normalizePageUrl(url)
		if (!byKey.has(key)) byKey.set(key, url)
	}
	return [...byKey.values()]
}

// ── Rotation ───────────────────────────────────────────────────────────────

/** One page of a property: tracked (live content) or seen only in the sync rows. */
export interface PageEntry {
	url: string
	key: string
	source: IndexRow['source']
}

/** Tracked pages plus the seen-only pages, one entry per normalized URL. A tracked page is never also seen. */
export function buildPages(
	trackedUrls: readonly string[],
	seenUrls: readonly string[],
): PageEntry[] {
	const pages = new Map<string, PageEntry>()
	for (const url of trackedUrls) {
		const key = normalizePageUrl(url)
		if (!pages.has(key)) pages.set(key, { url, key, source: 'tracked' })
	}
	for (const url of seenUrls) {
		const key = normalizePageUrl(url)
		if (!pages.has(key)) pages.set(key, { url, key, source: 'seen' })
	}
	return [...pages.values()]
}

/**
 * Keep at most max pages. Tracked pages stay; seen-only pages go first, and
 * among those the ones never inspected go before the ones with a stored row.
 */
export function capPages(
	pages: PageEntry[],
	stored: ReadonlyMap<string, IndexRow>,
	max = MAX_INDEX_ROWS,
): { kept: PageEntry[]; dropped: number } {
	if (pages.length <= max) return { kept: pages, dropped: 0 }
	const tracked = pages.filter((p) => p.source === 'tracked')
	const seen = pages
		.filter((p) => p.source === 'seen')
		.sort((a, b) => Number(stored.has(b.key)) - Number(stored.has(a.key)))
	const kept = [...tracked, ...seen].slice(0, max)
	return { kept, dropped: pages.length - kept.length }
}

const DAY_MS = 24 * 60 * 60 * 1000

function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
}

/**
 * The pages to inspect in this run, in order. A tracked page is due once per
 * calendar date, a seen-only page once 7 dates have passed. Tracked pages go
 * first, each group oldest checked first (never checked before all). The list
 * is cut so no more than cap inspections happen on one date: the rows stamped
 * today are the ones already done, so a second tick the same date gets what is
 * left and a full day gets nothing.
 */
export function planInspections(
	pages: readonly PageEntry[],
	stored: ReadonlyMap<string, IndexRow>,
	today: string,
	cap = INSPECT_DAILY_CAP,
): PageEntry[] {
	let doneToday = 0
	for (const found of stored.values()) {
		if (dateOf(found.checked_at) === today) doneToday++
	}

	const due = pages.filter((page) => {
		const found = stored.get(page.key)
		if (!found) return true
		const checked = dateOf(found.checked_at)
		return page.source === 'tracked'
			? checked !== today
			: daysBetween(checked, today) >= SEEN_CADENCE_DAYS
	})
	const checkedAt = (page: PageEntry) => stored.get(page.key)?.checked_at ?? ''
	const oldestFirst = (a: PageEntry, b: PageEntry) => {
		const [left, right] = [checkedAt(a), checkedAt(b)]
		return left < right ? -1 : left > right ? 1 : 0
	}
	const tracked = due.filter((page) => page.source === 'tracked').sort(oldestFirst)
	const seen = due.filter((page) => page.source === 'seen').sort(oldestFirst)
	return [...tracked, ...seen].slice(0, Math.max(0, cap - doneToday))
}

// ── Inspection ─────────────────────────────────────────────────────────────

function emptyRow(
	url: string,
	source: IndexRow['source'],
	checkedAt: string,
	today: string,
): IndexRow {
	return {
		url,
		source,
		checked_at: checkedAt,
		state: 'unknown',
		verdict: null,
		coverageState: null,
		lastCrawlTime: null,
		robotsTxtState: null,
		indexingState: null,
		pageFetchState: null,
		googleCanonical: null,
		userCanonical: null,
		state_since: today,
		error: null,
	}
}

/**
 * The page's row after one inspection. A failed call keeps the message and sets
 * state unknown. A 429 (after gscFetch's retries) or a 403 is about the property,
 * not the page, so it is thrown for the caller to handle.
 */
async function inspectToRow(
	accessToken: string,
	siteUrl: string,
	page: PageEntry,
	now: Date,
	previous: IndexRow | undefined,
	sleep?: Sleep,
): Promise<IndexRow> {
	const { url } = page
	const today = isoDate(now)
	const row = emptyRow(url, page.source, now.toISOString(), today)
	try {
		const result = await inspectUrl(accessToken, siteUrl, url, sleep)
		row.state = deriveIndexState(url, result)
		row.verdict = result.verdict ?? null
		row.coverageState = result.coverageState ?? null
		row.lastCrawlTime = result.lastCrawlTime ?? null
		row.robotsTxtState = result.robotsTxtState ?? null
		row.indexingState = result.indexingState ?? null
		row.pageFetchState = result.pageFetchState ?? null
		row.googleCanonical = result.googleCanonical ?? null
		row.userCanonical = result.userCanonical ?? null
	} catch (err) {
		if (err instanceof GscApiError && (err.status === 429 || err.status === 403)) throw err
		row.error = (err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX_LENGTH)
	}
	row.state_since = previous && previous.state === row.state ? previous.state_since : today
	return row
}

export interface InspectDeps {
	now: Date
	sleep?: Sleep
	/** Called at most once, and only when a page is due, so a quiet tick makes no Google call. */
	getAccessToken: () => Promise<string>
}

export interface InspectSummary {
	inspected: number
	errors: number
	/** Tracked pages no connected property covers: counted, not retried. */
	noProperty: number
	properties: number
	/** Properties whose run a 429 stopped (it resumes on the next tick). */
	quotaStopped: number
	/** Properties recorded as failed: a 403, or every inspection in the run errored. */
	failed: number
}

const inspectInFlight = new Set<string>()

/**
 * Inspect the workspace's pages and save the result on each property's index
 * object, then write the state onto the live content objects. The pages are the
 * tracked ones (live content, once per calendar date) and the seen-only ones
 * (in the property's last 30 days of sync rows, every 7 dates), at most 300
 * inspections per property per date, tracked first and oldest checked first.
 * Ticks run every 6 hours; a page inside its cadence is skipped, so the extra
 * ticks make no Google call. Only properties that contain a tracked page are
 * inspected.
 *
 * Errors: a page that fails stores its message and the run goes on. A 429 that
 * survives gscFetch's retries stops that property for this run (quota_stopped_at,
 * rows already inspected kept); a 403 skips it with last_error and
 * first_failure_at; a property whose inspections all errored is recorded failed
 * the same way. Other properties still run. Never touches the integration's
 * sync state or status.
 */
export async function inspectIndexStatus(
	db: Database,
	row: GscIntegrationRow,
	deps: InspectDeps,
): Promise<InspectSummary | null> {
	if (inspectInFlight.has(row.id)) return null
	inspectInFlight.add(row.id)
	try {
		const { now } = deps
		const today = isoDate(now)
		const sleep = deps.sleep ?? defaultSleep
		const summary: InspectSummary = {
			inspected: 0,
			errors: 0,
			noProperty: 0,
			properties: 0,
			quotaStopped: 0,
			failed: 0,
		}

		const properties = await listPropertyUrls(db, row)
		const byProperty = new Map<string, string[]>()
		for (const url of await listTrackedUrls(db, row.workspaceId)) {
			const property = propertyForUrl(url, properties)
			if (!property) {
				summary.noProperty++
				continue
			}
			byProperty.set(property, [...(byProperty.get(property) ?? []), url])
		}

		let accessToken: string | undefined
		let tokenFailed = false
		for (const [siteUrl, trackedUrls] of byProperty) {
			try {
				const existing = await findIndexObject(db, row.workspaceId, siteUrl)
				const stored = new Map(
					parseIndexRows(existing?.content ?? null).map((r) => [normalizePageUrl(r.url), r]),
				)
				const seenUrls = await listSeenUrls(db, row.workspaceId, siteUrl, properties, now)
				const { kept, dropped } = capPages(buildPages(trackedUrls, seenUrls), stored)
				const plan = planInspections(kept, stored, today)
				if (plan.length === 0) continue

				if (accessToken === undefined) {
					try {
						accessToken = await deps.getAccessToken()
					} catch (err) {
						tokenFailed = true
						throw err
					}
				}
				// Stored rows of pages that are no longer in the list drop out.
				const rows = new Map<string, IndexRow>()
				for (const page of kept) {
					const found = stored.get(page.key)
					if (found) rows.set(page.key, { ...found, source: page.source })
				}

				let inspected = 0
				let errored = 0
				let firstError = ''
				let quotaStoppedAt: string | undefined
				let failure: string | undefined
				for (const page of plan) {
					if (inspected > 0) await sleep(INSPECT_PACING_MS)
					try {
						const next = await inspectToRow(
							accessToken,
							siteUrl,
							page,
							now,
							stored.get(page.key),
							deps.sleep,
						)
						rows.set(page.key, next)
						inspected++
						if (next.error) {
							errored++
							firstError ||= next.error
						}
					} catch (err) {
						// inspectToRow only throws what is about the whole property.
						if (err instanceof GscApiError && err.status === 429) {
							quotaStoppedAt = now.toISOString()
						} else {
							const message = err instanceof Error ? err.message : String(err)
							failure = message.slice(0, ERROR_MAX_LENGTH)
						}
						break
					}
				}
				if (!failure && inspected > 0 && errored === inspected) {
					failure = `Every inspection in this run failed: ${firstError}`.slice(0, ERROR_MAX_LENGTH)
				}

				const previous = existing?.metadata as {
					first_failure_at?: string
					last_inspected_date?: string
				} | null
				let firstFailureAt: string | undefined
				if (failure) firstFailureAt = previous?.first_failure_at ?? now.toISOString()
				let lastError = failure
				if (!lastError && dropped > 0) {
					lastError = `Over the ${MAX_INDEX_ROWS} row limit: dropped ${dropped} pages, seen-only first`
				}
				await saveIndexObject(db, {
					row,
					siteUrl,
					rows: [...rows.values()],
					lastInspectedDate: inspected > 0 ? today : previous?.last_inspected_date,
					inspected,
					quotaStoppedAt,
					lastError,
					firstFailureAt,
				})
				summary.inspected += inspected
				summary.errors += errored
				summary.properties++
				if (quotaStoppedAt) summary.quotaStopped++
				if (failure) summary.failed++
			} catch (err) {
				// A failed token fetch aborts the step; anything else only costs this property.
				if (tokenFailed) throw err
				logger.error('GSC index inspection failed for a property', {
					integrationId: row.id,
					siteUrl,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}

		await writeIndexState(db, { workspaceId: row.workspaceId, actorId: row.createdBy })
		logger.info('GSC index status inspected', { integrationId: row.id, ...summary })
		return summary
	} finally {
		inspectInFlight.delete(row.id)
	}
}

// ── Writeback ──────────────────────────────────────────────────────────────

export interface IndexStateResult {
	updated: number
	unchanged: number
	/** Live pages with no inspection row yet: left as they were. */
	skipped: number
}

/**
 * Set gsc_index_state, gsc_coverage_state and gsc_index_checked_at on every
 * live content object that has a canonical_url, from the workspace's index
 * objects. Written only when one of the three changes, merged into the existing
 * metadata, with one audit event naming the changed fields. Never touches
 * rank_band (the Analyst's) or gsc_index_request (a separate manual flow).
 */
export async function writeIndexState(
	db: Database,
	args: { workspaceId: string; actorId: string },
): Promise<IndexStateResult> {
	const { workspaceId, actorId } = args

	const indexObjects = await db
		.select({ content: objects.content })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'knowledge'),
				sql`${objects.metadata}->>'provider' = ${GSC_INDEX_PROVIDER}`,
			),
		)
	const latest = new Map<string, IndexRow>()
	for (const { content } of indexObjects) {
		for (const r of parseIndexRows(content)) {
			const key = normalizePageUrl(r.url)
			const seen = latest.get(key)
			if (!seen || r.checked_at > seen.checked_at) latest.set(key, r)
		}
	}

	const pieces = await db
		.select({ id: objects.id, metadata: objects.metadata })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'content'),
				eq(objects.status, 'live'),
				sql`btrim(coalesce(${objects.metadata}->>'canonical_url', '')) <> ''`,
			),
		)

	const result: IndexStateResult = { updated: 0, unchanged: 0, skipped: 0 }
	for (const piece of pieces) {
		const metadata = (piece.metadata ?? {}) as Record<string, unknown>
		const found = latest.get(normalizePageUrl(String(metadata.canonical_url)))
		if (!found) {
			result.skipped++
			continue
		}

		const next: Record<string, string> = {
			gsc_index_state: found.state,
			gsc_coverage_state: found.coverageState ?? '',
			gsc_index_checked_at: dateOf(found.checked_at),
		}
		const changed = Object.entries(next).filter(([field, value]) => metadata[field] !== value)
		if (changed.length === 0) {
			result.unchanged++
			continue
		}

		await db
			.update(objects)
			.set({
				metadata: sql`${objects.metadata} || ${JSON.stringify(Object.fromEntries(changed))}::jsonb`,
				updatedAt: new Date(),
			})
			.where(eq(objects.id, piece.id))
		// Only the changed fields, never the whole metadata blob: events feed a NOTIFY payload capped at 8KB.
		await recordEvent(db, {
			workspaceId,
			actorId,
			action: 'updated',
			entityType: 'content',
			entityId: piece.id,
			data: {
				source: SEARCH_DEMAND_EVENT_SOURCE,
				fields: changed.map(([field]) => field),
				old: Object.fromEntries(changed.map(([field]) => [field, clip(metadata[field])])),
				new: Object.fromEntries(changed.map(([field, value]) => [field, clip(value)])),
			},
		})
		result.updated++
	}

	logger.info('GSC index state written', { workspaceId, ...result })
	return result
}

function clip(value: unknown): unknown {
	return typeof value === 'string' ? value.slice(0, COVERAGE_EVENT_MAX_LENGTH) : (value ?? null)
}
