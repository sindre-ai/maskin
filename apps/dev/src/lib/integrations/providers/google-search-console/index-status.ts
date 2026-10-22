import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { recordEvent } from '../../../events/record-event'
import { isKnowledgeTitleUniqueViolation } from '../../../knowledge-dedup'
import { logger } from '../../../logger'
import { SEARCH_DEMAND_EVENT_SOURCE, normalizePageUrl } from './search-demand'
import { GSC_PROVIDER, type GscIntegrationRow, gscFetch, isoDate } from './sync'

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
	today: string
	inspected: number
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
		last_inspected_date: args.today,
		urls_tracked: rows.filter((r) => r.source === 'tracked').length,
		urls_inspected_last_run: args.inspected,
		indexed_count: count('indexed'),
		canonical_elsewhere_count: count('canonical_elsewhere'),
		not_indexed_count: count('not_indexed'),
		unknown_count: count('unknown'),
		error_count: rows.filter((r) => r.error !== null).length,
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

// ── Inspection ─────────────────────────────────────────────────────────────

function emptyRow(url: string, checkedAt: string, today: string): IndexRow {
	return {
		url,
		source: 'tracked',
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

/** The page's row after one inspection. A failed call keeps the message and sets state unknown. */
async function inspectToRow(
	accessToken: string,
	siteUrl: string,
	url: string,
	now: Date,
	previous: IndexRow | undefined,
	sleep?: Sleep,
): Promise<IndexRow> {
	const today = isoDate(now)
	const row = emptyRow(url, now.toISOString(), today)
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
}

const inspectInFlight = new Set<string>()

/**
 * Inspect the workspace's tracked pages once per calendar date (UTC), save the
 * result on each property's index object, then write the state onto the live
 * content objects. Ticks run every 6 hours; a page checked today is skipped, so
 * the extra ticks make no Google call. Only properties that contain a tracked
 * page are inspected. A page that fails stores its message and the run goes on.
 * Never touches the integration's sync state or status.
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
		const summary: InspectSummary = { inspected: 0, errors: 0, noProperty: 0, properties: 0 }

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
				const due = trackedUrls.filter((url) => {
					const found = stored.get(normalizePageUrl(url))
					return !found || dateOf(found.checked_at) !== today
				})
				if (due.length === 0) continue

				if (accessToken === undefined) {
					try {
						accessToken = await deps.getAccessToken()
					} catch (err) {
						tokenFailed = true
						throw err
					}
				}
				const trackedKeys = new Set(trackedUrls.map(normalizePageUrl))
				// Seen-only rows stay as they are; tracked rows for pages no longer live drop out.
				const rows = new Map(
					[...stored].filter(([key, r]) => r.source !== 'tracked' || trackedKeys.has(key)),
				)
				let inspected = 0
				for (const url of due) {
					if (inspected > 0) await sleep(INSPECT_PACING_MS)
					const key = normalizePageUrl(url)
					const next = await inspectToRow(
						accessToken,
						siteUrl,
						url,
						now,
						stored.get(key),
						deps.sleep,
					)
					rows.set(key, next)
					inspected++
					if (next.error) summary.errors++
				}
				await saveIndexObject(db, { row, siteUrl, rows: [...rows.values()], today, inspected })
				summary.inspected += inspected
				summary.properties++
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
