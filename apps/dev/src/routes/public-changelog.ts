import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { CHANGELOG_ENTRY_TYPE } from '@maskin/ext-changelog/shared'
import { and, desc, eq } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'

// Public, no-auth feed of published changelog entries for the marketing site
// (sindre.ai/changelog). Two formats:
//   GET /v1/changelog      → JSON  { entries: [...] }
//   GET /v1/changelog.xml  → RSS 2.0
//
// Source: `changelog_entry` objects with status `published`, scoped to the
// Sindre AI public workspace. Newest-first by published-at (the row's
// updated_at, which advances when the Changelog Publisher flips status to
// `published`). Hard cap at 200 entries to bound payload size — pagination
// is deferred until traffic actually warrants it.
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
		.orderBy(desc(objects.updatedAt))
		.limit(MAX_ENTRIES)

	return rows.map((r) => {
		const meta = (r.metadata ?? {}) as Record<string, unknown>
		const tag = typeof meta.tag === 'string' ? meta.tag : null
		const heroImageUrl =
			typeof meta.hero_image_url === 'string' && meta.hero_image_url.length > 0
				? meta.hero_image_url
				: undefined
		// updated_at is the moment the Publisher flipped status to `published`;
		// fall back to the current time only if the column is unexpectedly null
		// (defaultNow on insert should make this practically unreachable).
		const publishedAt = (r.updatedAt ?? new Date()).toISOString()
		const entry: ChangelogEntry = {
			id: r.id,
			title: r.title ?? '',
			content: r.content ?? '',
			tag,
			published_at: publishedAt,
		}
		if (heroImageUrl) entry.hero_image_url = heroImageUrl
		return entry
	})
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
