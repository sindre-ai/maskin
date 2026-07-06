import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { CHANGELOG_ENTRY_TAGS, CHANGELOG_ENTRY_TYPE } from '@maskin/ext-changelog/shared'
import { and, desc, eq } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'

// Public, no-auth feed of published changelog entries for the marketing site
// (sindre.ai/changelog). Two formats:
//   GET /v1/changelog      → JSON  { entries: [...] }
//   GET /v1/changelog.xml  → RSS 2.0
//
// Source: `changelog_entry` objects with status `published`, scoped to the
// Sindre AI public workspace. Newest-first by published-at, which prefers the
// explicit `metadata.published_at` field (set by whoever/whatever flips status
// to `published`) and only falls back to the row's `updated_at` when that field
// is absent — the row's updated_at otherwise advances on *any* later edit
// (typo fix, hero image swap, etc.), which would wrongly re-date and re-sort an
// already-published entry. Hard cap at 200 entries to bound payload size —
// pagination is deferred until traffic actually warrants it.
//
// Mounted at `/v1` in app-factory.ts; `/v1/*` is outside the `/api/*` auth
// allowlist so no auth bypass entry is needed. CORS is scoped to
// `https://sindre.ai` (the only consumer in scope today) by middleware in
// app-factory.

type Env = {
	Variables: {
		db: Database
	}
}

// The Sindre AI public workspace whose published changelog entries surface
// on the marketing site. Hardcoded because this endpoint serves exactly one
// workspace by contract — making it configurable would invite cross-tenant
// leakage on misconfiguration.
export const SINDRE_AI_PUBLIC_WORKSPACE_ID = 'fe944fe6-7b45-478c-afc7-b889cea63c08'

const MAX_ENTRIES = 200
// Rows are fetched (bounded, ordered by updated_at) before being re-sorted by
// resolved published-at and truncated to MAX_ENTRIES — this bounds query cost
// while still producing a correct top-200-by-published-at result even though
// published_at isn't a DB column. Far larger than any realistic entry count
// for a weekly changelog for the foreseeable future.
const FETCH_LIMIT = 2000
const RSS_CHANNEL_TITLE = 'Maskin changelog'
const RSS_CHANNEL_LINK = 'https://sindre.ai/changelog'
const RSS_CHANNEL_DESCRIPTION = 'What we shipped at Maskin, week by week.'

interface ChangelogEntry {
	id: string
	title: string
	content: string
	tag: string | null
	published_at: string
	hero_image_url?: string
}

const VALID_TAGS = CHANGELOG_ENTRY_TAGS as readonly string[]

// Prefers the explicit `metadata.published_at` (set by whoever/whatever flips
// status to `published`) so later content edits don't change an entry's public
// date. Falls back to `updated_at`, and only to "now" if that's also missing
// (shouldn't happen — updated_at defaults on insert — but a public feed must
// never throw over a row-level data quirk).
function resolvePublishedAt(
	objectId: string,
	meta: Record<string, unknown>,
	updatedAt: Date | null,
) {
	if (typeof meta.published_at === 'string') {
		const parsed = new Date(meta.published_at)
		if (!Number.isNaN(parsed.getTime())) return parsed
	}
	if (updatedAt) return updatedAt
	logger.warn('public-changelog: entry missing updated_at, using now()', { objectId })
	return new Date()
}

async function loadPublishedEntries(db: Database): Promise<ChangelogEntry[]> {
	const rows = await db
		.select({
			id: objects.id,
			title: objects.title,
			content: objects.content,
			metadata: objects.metadata,
			updatedAt: objects.updatedAt,
		})
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, SINDRE_AI_PUBLIC_WORKSPACE_ID),
				eq(objects.type, CHANGELOG_ENTRY_TYPE),
				eq(objects.status, 'published'),
			),
		)
		// Ordered/bounded by updated_at at the DB level purely to cap query cost;
		// the actual newest-first ordering used in the response is resolved and
		// re-sorted below by published_at (see resolvePublishedAt).
		.orderBy(desc(objects.updatedAt))
		.limit(FETCH_LIMIT)

	const resolved = rows.map((r) => {
		const meta = (r.metadata ?? {}) as Record<string, unknown>

		const tag = typeof meta.tag === 'string' ? meta.tag : null
		if (tag === null || !VALID_TAGS.includes(tag)) {
			logger.warn('public-changelog: published entry has invalid tag metadata', {
				objectId: r.id,
				rawTag: meta.tag,
			})
		}

		const heroImageUrl =
			typeof meta.hero_image_url === 'string' && meta.hero_image_url.length > 0
				? meta.hero_image_url
				: undefined

		const publishedAt = resolvePublishedAt(r.id, meta, r.updatedAt)

		const entry: ChangelogEntry = {
			id: r.id,
			title: r.title ?? '',
			content: r.content ?? '',
			tag: tag !== null && VALID_TAGS.includes(tag) ? tag : null,
			published_at: publishedAt.toISOString(),
		}
		if (heroImageUrl) entry.hero_image_url = heroImageUrl
		return { entry, publishedAt }
	})

	resolved.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())

	return resolved.slice(0, MAX_ENTRIES).map((r) => r.entry)
}

// Minimal XML escape covering the five characters RSS 2.0 readers care about.
// We're emitting our own copy here rather than pulling a dependency because
// the surface is two tags (`title`, `description`) per item, and any escape
// library we'd reach for would bring in transitive deps we don't otherwise need.
function escapeXml(input: string): string {
	return input
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
}

function toRfc822(iso: string): string {
	return new Date(iso).toUTCString()
}

function buildRssFeed(entries: ChangelogEntry[], lastBuildIso: string): string {
	const items = entries
		.map((e) => {
			const link = `${RSS_CHANNEL_LINK}#${e.id}`
			const tagLine = e.tag ? `[${e.tag}] ` : ''
			return [
				'    <item>',
				`      <title>${escapeXml(`${tagLine}${e.title}`)}</title>`,
				`      <link>${escapeXml(link)}</link>`,
				`      <guid isPermaLink="false">${escapeXml(e.id)}</guid>`,
				`      <pubDate>${toRfc822(e.published_at)}</pubDate>`,
				`      <description>${escapeXml(e.content)}</description>`,
				'    </item>',
			].join('\n')
		})
		.join('\n')

	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<rss version="2.0">',
		'  <channel>',
		`    <title>${escapeXml(RSS_CHANNEL_TITLE)}</title>`,
		`    <link>${escapeXml(RSS_CHANNEL_LINK)}</link>`,
		`    <description>${escapeXml(RSS_CHANNEL_DESCRIPTION)}</description>`,
		`    <lastBuildDate>${toRfc822(lastBuildIso)}</lastBuildDate>`,
		items ? `${items}` : '',
		'  </channel>',
		'</rss>',
	]
		.filter((line) => line.length > 0)
		.join('\n')
}

const app = new OpenAPIHono<Env>()

app.get('/changelog', async (c) => {
	const db = c.get('db')
	try {
		const entries = await loadPublishedEntries(db)
		logger.info('public-changelog: json served', { count: entries.length })
		return c.json({ entries })
	} catch (err) {
		logger.error('public-changelog: json failed', {
			err: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to load changelog'), 500)
	}
})

app.get('/changelog.xml', async (c) => {
	const db = c.get('db')
	try {
		const entries = await loadPublishedEntries(db)
		const lastBuild = entries[0]?.published_at ?? new Date().toISOString()
		const xml = buildRssFeed(entries, lastBuild)
		logger.info('public-changelog: rss served', { count: entries.length })
		c.header('Content-Type', 'application/rss+xml; charset=utf-8')
		return c.body(xml)
	} catch (err) {
		logger.error('public-changelog: rss failed', {
			err: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to load changelog'), 500)
	}
})

app.onError((err, c) => {
	logger.error('public-changelog: unhandled error', {
		err: err instanceof Error ? err.message : String(err),
		stack: err instanceof Error ? err.stack : undefined,
	})
	return c.json(createApiError('INTERNAL_ERROR', 'An unexpected error occurred'), 500)
})

export default app
