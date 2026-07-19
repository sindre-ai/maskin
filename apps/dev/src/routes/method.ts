import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { objects, workspaces } from '@maskin/db/schema'
import { renderMarkdownToHtml } from '@maskin/markdown/render'
import { workspaceSettingsSchema } from '@maskin/shared'
import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { buildMethodSitePageviewScript } from '../lib/analytics/method-site-pageview'

// Public server-rendered method-site routes (`/method/development` cover +
// `/method/development/:slug` chapter view). Spec: Direction A · Broadsheet
// from the editorial design plan; ADR-1..ADR-5 + #6/#7/#8 from the arch
// review on the Publish bet.
//
// Mounted in `app-factory.ts` BEFORE the SPA fallthrough so `/method/*`
// never falls through to `index.html`.

type Env = {
	Variables: {
		db: Database
	}
}

const method = new Hono<Env>()

// ── Publishable-object query (ADR #7) ───────────────────────────────────────
//
// A knowledge object is publishable iff:
//   type = 'knowledge' AND status = 'validated' AND metadata.grade = 'chapter'
//   AND no active `contradicts` inbound edge (target_id = object.id).
//
// The workspace itself must have `settings.publish.enabled = true` — checked
// once up-front before this query runs so an unopted workspace serves an
// empty cover instead of leaking anything.

type PublishSettings = {
	enabled: boolean
	slug?: string
	title?: string
	description?: string
	visibility?: 'public' | 'unlisted'
	version?: number
}

function readPublishSettings(raw: unknown): PublishSettings {
	const parsed = workspaceSettingsSchema.partial().safeParse(raw)
	if (!parsed.success) return { enabled: false }
	const publish = parsed.data.publish
	if (!publish) return { enabled: false }
	return {
		enabled: publish.enabled ?? false,
		slug: publish.slug,
		title: publish.title,
		description: publish.description,
		visibility: publish.visibility,
		version: publish.version ?? 0,
	}
}

type PublishableChapter = {
	id: string
	title: string
	content: string
	updatedAt: Date
	metadata: Record<string, unknown> | null
}

async function loadPublishableChapters(
	db: Database,
	workspaceId: string,
): Promise<PublishableChapter[]> {
	const rows = await db
		.select({
			id: objects.id,
			title: objects.title,
			content: objects.content,
			updatedAt: objects.updatedAt,
			metadata: objects.metadata,
		})
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'knowledge'),
				eq(objects.status, 'validated'),
				// Correlated NOT EXISTS on relationships — literal, table-qualified
				// SQL per known-pitfalls.md so no Drizzle column object renders
				// unqualified inside the correlated subquery.
				sql`(objects.metadata->>'grade') = 'chapter'`,
				sql`NOT EXISTS (
					SELECT 1 FROM relationships
					WHERE relationships.target_id = objects.id
					  AND relationships.type = 'contradicts'
				)`,
			),
		)

	return rows
		.filter((r): r is PublishableChapter => r.title !== null && r.content !== null)
		.map((r) => ({
			id: r.id,
			title: r.title ?? '',
			content: r.content ?? '',
			updatedAt: r.updatedAt ?? new Date(0),
			metadata: (r.metadata as Record<string, unknown> | null) ?? null,
		}))
}

// ── Slug (ADR #8) ───────────────────────────────────────────────────────────
//
// `title-slug-<sha1(objectId)[0:6]>` — the short-hash suffix is stable and
// immutable across title edits. The title portion is best-effort — kebab-case
// of the current title with non-word chars stripped.

function toKebab(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'chapter'
	)
}

export function slugFor(objectId: string, title: string): string {
	const hash = createHash('sha1').update(objectId).digest('hex').slice(0, 6)
	return `${toKebab(title)}-${hash}`
}

// ── ETag + LRU (ADR #4) ─────────────────────────────────────────────────────
//
// Small in-process LRU keyed by ETag — ~100 entries per Hono instance is
// enough for a warm-cache method site. Overflow evicts the oldest entry.

const RENDER_CACHE_MAX = 100
const renderCache = new Map<string, string>()

function cacheGet(key: string): string | undefined {
	const hit = renderCache.get(key)
	if (hit === undefined) return undefined
	// LRU refresh: re-insert to move to the tail
	renderCache.delete(key)
	renderCache.set(key, hit)
	return hit
}

function cacheSet(key: string, value: string): void {
	if (renderCache.has(key)) renderCache.delete(key)
	renderCache.set(key, value)
	if (renderCache.size > RENDER_CACHE_MAX) {
		const oldest = renderCache.keys().next().value
		if (oldest !== undefined) renderCache.delete(oldest)
	}
}

function coverEtag(chapters: PublishableChapter[], publishVersion: number): string {
	const maxUpdated = chapters.reduce((acc, c) => Math.max(acc, c.updatedAt.getTime()), 0)
	return `"${createHash('sha1')
		.update(`cover:${maxUpdated}:${publishVersion}:${chapters.length}`)
		.digest('hex')
		.slice(0, 16)}"`
}

function chapterEtag(chapter: PublishableChapter, publishVersion: number): string {
	return `"${createHash('sha1')
		.update(`chapter:${chapter.id}:${chapter.updatedAt.getTime()}:${publishVersion}`)
		.digest('hex')
		.slice(0, 16)}"`
}

const CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=86400'

// ── Editorial layer (Direction A · Broadsheet) ─────────────────────────────
//
// Inlined CSS + HTML skeleton. The CSS is scoped to the served page — no
// external stylesheets, no build step. Tokens:
//   surface   = warm linen (#f4ede1) / dark (#1a1815)
//   ink       = near-black (#1a1a1a) / dark (#e8e2d4)
//   accent    = Falu red (#7a2727) / dark (#e6928a)
//   display   = Schibsted Grotesk (fallback: system sans-serif)
//   body      = Newsreader (fallback: Georgia / serif)

const EDITORIAL_CSS = `
:root {
	--surface: #f4ede1;
	--surface-alt: #eae1d0;
	--ink: #1a1a1a;
	--ink-soft: #4a4a44;
	--accent: #7a2727;
	--rule: rgba(26, 26, 26, 0.42);
	--rule-strong: rgba(26, 26, 26, 0.85);
}
@media (prefers-color-scheme: dark) {
	:root {
		--surface: #1a1815;
		--surface-alt: #24211d;
		--ink: #e8e2d4;
		--ink-soft: #b7b0a1;
		--accent: #e6928a;
		--rule: rgba(232, 226, 212, 0.4);
		--rule-strong: rgba(232, 226, 212, 0.85);
	}
}
* { box-sizing: border-box; }
html, body {
	margin: 0;
	padding: 0;
	background: var(--surface);
	color: var(--ink);
	font-family: 'Newsreader', Georgia, 'Iowan Old Style', 'Palatino Linotype', serif;
	font-size: 18px;
	line-height: 1.55;
	-webkit-font-smoothing: antialiased;
	text-rendering: optimizeLegibility;
}
a {
	color: var(--accent);
	text-decoration: underline;
	text-decoration-thickness: 1px;
	text-underline-offset: 2px;
}
a:hover { text-decoration-thickness: 2px; }
.display {
	font-family: 'Schibsted Grotesk', 'Helvetica Neue', Arial, sans-serif;
	font-weight: 700;
	letter-spacing: -0.01em;
}
.method-page { max-width: 1200px; margin: 0 auto; padding: 32px 24px 96px; }

/* Cover — broadsheet */
.masthead {
	text-align: center;
	border-bottom: 4px double var(--rule-strong);
	padding-bottom: 20px;
	margin-bottom: 20px;
}
.masthead__title {
	font-family: 'Newsreader', Georgia, serif;
	font-weight: 700;
	font-size: clamp(40px, 6vw, 68px);
	line-height: 1;
	margin: 0 0 6px;
	letter-spacing: -0.01em;
}
.masthead__tag {
	font-family: 'Schibsted Grotesk', sans-serif;
	text-transform: uppercase;
	letter-spacing: 0.28em;
	font-size: 11px;
	color: var(--ink-soft);
}
.dateline {
	display: flex;
	justify-content: space-between;
	align-items: baseline;
	font-family: 'Schibsted Grotesk', sans-serif;
	text-transform: uppercase;
	letter-spacing: 0.18em;
	font-size: 11px;
	color: var(--ink-soft);
	border-bottom: 1px solid var(--rule);
	padding-bottom: 10px;
	margin-bottom: 28px;
}
.featured {
	display: grid;
	grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
	gap: 40px;
	padding-bottom: 32px;
	border-bottom: 4px double var(--rule-strong);
	margin-bottom: 32px;
}
@media (max-width: 900px) {
	.featured { grid-template-columns: 1fr; gap: 24px; }
}
.featured__lead h2 {
	font-family: 'Newsreader', Georgia, serif;
	font-weight: 700;
	font-size: clamp(30px, 4.5vw, 52px);
	line-height: 1.05;
	margin: 0 0 12px;
	letter-spacing: -0.01em;
}
.featured__lead p {
	font-size: 20px;
	line-height: 1.55;
	color: var(--ink);
	margin: 0 0 12px;
}
.featured__lead a { color: var(--ink); text-decoration: none; }
.featured__lead a:hover { color: var(--accent); }
.featured__lead .kicker {
	font-family: 'Schibsted Grotesk', sans-serif;
	text-transform: uppercase;
	letter-spacing: 0.24em;
	font-size: 11px;
	color: var(--accent);
	margin-bottom: 10px;
}
.siblings h3 {
	font-family: 'Schibsted Grotesk', sans-serif;
	text-transform: uppercase;
	letter-spacing: 0.24em;
	font-size: 11px;
	color: var(--ink-soft);
	margin: 0 0 12px;
	padding-bottom: 8px;
	border-bottom: 1px solid var(--rule);
}
.siblings ul { list-style: none; padding: 0; margin: 0; }
.siblings li { border-bottom: 1px solid var(--rule); padding: 12px 0; }
.siblings li:last-child { border-bottom: none; }
.siblings a {
	color: var(--ink);
	text-decoration: none;
	font-family: 'Newsreader', Georgia, serif;
	font-weight: 600;
	font-size: 17px;
	display: block;
	min-height: 44px;
	line-height: 1.3;
}
.siblings a:hover { color: var(--accent); }
.section-grid {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 32px;
	padding-top: 8px;
}
@media (max-width: 900px) {
	.section-grid { grid-template-columns: 1fr; gap: 20px; }
}
.section-grid article {
	border-top: 1px solid var(--rule);
	padding-top: 16px;
}
.section-grid article h4 {
	font-family: 'Newsreader', Georgia, serif;
	font-weight: 700;
	font-size: 22px;
	margin: 0 0 8px;
	line-height: 1.2;
}
.section-grid article a {
	color: var(--ink);
	text-decoration: none;
	min-height: 44px;
	display: block;
}
.section-grid article a:hover { color: var(--accent); }
.section-grid article .kicker {
	font-family: 'Schibsted Grotesk', sans-serif;
	text-transform: uppercase;
	letter-spacing: 0.22em;
	font-size: 10px;
	color: var(--accent);
	margin-bottom: 6px;
}
.empty-cover {
	text-align: center;
	padding: 80px 20px;
	color: var(--ink-soft);
	font-style: italic;
}

/* Article — Newsreader ~68ch */
.article {
	max-width: 68ch;
	margin: 0 auto;
	padding: 0 24px;
}
.article__back {
	font-family: 'Schibsted Grotesk', sans-serif;
	text-transform: uppercase;
	letter-spacing: 0.2em;
	font-size: 11px;
	display: inline-block;
	min-height: 44px;
	padding: 12px 0;
	text-decoration: none;
	color: var(--ink-soft);
}
.article__back:hover { color: var(--accent); text-decoration: underline; }
.article header {
	border-top: 4px double var(--rule-strong);
	border-bottom: 1px solid var(--rule);
	padding: 20px 0 16px;
	margin-bottom: 28px;
}
.article header .kicker {
	font-family: 'Schibsted Grotesk', sans-serif;
	text-transform: uppercase;
	letter-spacing: 0.24em;
	font-size: 11px;
	color: var(--accent);
	margin-bottom: 10px;
}
.article header h1 {
	font-family: 'Newsreader', Georgia, serif;
	font-weight: 700;
	font-size: clamp(30px, 4.5vw, 44px);
	line-height: 1.1;
	margin: 0 0 12px;
	letter-spacing: -0.01em;
}
.article header .dateline {
	border: none;
	padding: 0;
	margin: 0;
}
.article__body {
	font-size: 18px;
	line-height: 1.65;
}
.article__body > p:first-of-type::first-letter {
	font-family: 'Newsreader', Georgia, serif;
	color: var(--accent);
	float: left;
	font-size: 4.8em;
	line-height: 0.85;
	padding: 4px 10px 0 0;
	font-weight: 700;
}
.article__body h2 {
	font-family: 'Newsreader', Georgia, serif;
	font-weight: 700;
	font-size: 26px;
	line-height: 1.2;
	margin: 44px 0 12px;
	position: relative;
	padding-left: 18px;
}
.article__body h2::before {
	content: '';
	position: absolute;
	left: 0;
	top: 6px;
	bottom: 6px;
	width: 4px;
	background: var(--accent);
}
.article__body h3 {
	font-family: 'Newsreader', Georgia, serif;
	font-weight: 700;
	font-size: 20px;
	margin: 32px 0 10px;
}
.article__body p { margin: 0 0 18px; }
.article__body blockquote {
	border-left: 3px solid var(--accent);
	margin: 20px 0;
	padding: 4px 18px;
	color: var(--ink-soft);
	font-style: italic;
}
.article__body code {
	font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
	background: var(--surface-alt);
	padding: 1px 6px;
	border-radius: 3px;
	font-size: 0.9em;
}
.article__body pre {
	background: var(--surface-alt);
	padding: 16px;
	overflow-x: auto;
	border-radius: 4px;
	font-size: 0.9em;
	line-height: 1.5;
}
.article__body pre code { background: none; padding: 0; }
.article__body ul, .article__body ol { padding-left: 24px; margin: 0 0 18px; }
.article__body li { margin-bottom: 6px; }
.article__body table {
	width: 100%;
	border-collapse: collapse;
	margin: 20px 0;
	font-size: 0.95em;
}
.article__body th, .article__body td {
	border-bottom: 1px solid var(--rule);
	padding: 10px 8px;
	text-align: left;
}
.article__body th {
	font-family: 'Schibsted Grotesk', sans-serif;
	text-transform: uppercase;
	letter-spacing: 0.12em;
	font-size: 11px;
}
.article footer {
	border-top: 1px solid var(--rule);
	padding-top: 24px;
	margin-top: 40px;
	font-family: 'Schibsted Grotesk', sans-serif;
	text-transform: uppercase;
	letter-spacing: 0.2em;
	font-size: 11px;
	color: var(--ink-soft);
	display: flex;
	justify-content: space-between;
	align-items: center;
	min-height: 44px;
}
@media (min-width: 375px) { .article__body { font-size: 18px; } }
`.trim()

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

function pageShell(opts: {
	title: string
	description?: string
	body: string
	chapterSlug: string
}): string {
	// T2's ship-metric injection — must stay in <head> on every /method/* page
	// so `method_site_pageview` fires even after the editorial layer lands.
	const analytics = buildMethodSitePageviewScript({
		apiKey: process.env.VITE_POSTHOG_KEY,
		apiHost: process.env.VITE_POSTHOG_HOST,
		chapterSlug: opts.chapterSlug,
	})
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(opts.title)}</title>
${opts.description ? `<meta name="description" content="${escapeHtml(opts.description)}" />` : ''}
<meta name="robots" content="index, follow" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,600;6..72,700&family=Schibsted+Grotesk:wght@400;500;700&display=swap" />
${analytics}
<style>${EDITORIAL_CSS}</style>
</head>
<body>
${opts.body}
</body>
</html>`
}

function firstMetaString(meta: Record<string, unknown> | null, key: string): string | undefined {
	if (!meta) return undefined
	const raw = meta[key]
	return typeof raw === 'string' ? raw : undefined
}

function renderCover(opts: {
	siteTitle: string
	siteDescription?: string
	chapters: PublishableChapter[]
}): string {
	if (opts.chapters.length === 0) {
		return pageShell({
			title: opts.siteTitle,
			description: opts.siteDescription,
			chapterSlug: '',
			body: `<div class="method-page">
	<header class="masthead">
		<h1 class="masthead__title">${escapeHtml(opts.siteTitle)}</h1>
		<div class="masthead__tag">Development</div>
	</header>
	<div class="empty-cover">No chapters published yet.</div>
</div>`,
		})
	}

	// Featured = most-recently-updated chapter; siblings = next 4; grid = rest.
	const sorted = [...opts.chapters].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
	const [featured, ...rest] = sorted
	if (!featured) {
		return pageShell({
			title: opts.siteTitle,
			description: opts.siteDescription,
			chapterSlug: '',
			body: `<div class="method-page"><div class="empty-cover">No chapters.</div></div>`,
		})
	}
	const siblings = rest.slice(0, 4)
	const grid = rest.slice(4)

	const dateFormatter = new Intl.DateTimeFormat('en-GB', {
		day: 'numeric',
		month: 'long',
		year: 'numeric',
	})
	const dateline = dateFormatter.format(new Date())

	const featuredHref = `/method/development/${slugFor(featured.id, featured.title)}`
	const featuredKicker = firstMetaString(featured.metadata, 'section') ?? 'Chapter'
	const featuredDek =
		firstMetaString(featured.metadata, 'dek') ??
		featured.content.slice(0, 240).replace(/\s+/g, ' ').trim() +
			(featured.content.length > 240 ? '…' : '')

	const siblingsHtml = siblings
		.map((s) => {
			const href = `/method/development/${slugFor(s.id, s.title)}`
			return `<li><a href="${href}">${escapeHtml(s.title)}</a></li>`
		})
		.join('\n\t\t\t')

	const gridHtml = grid
		.map((g) => {
			const href = `/method/development/${slugFor(g.id, g.title)}`
			const kicker = firstMetaString(g.metadata, 'section') ?? 'Chapter'
			return `<article>
			<div class="kicker">${escapeHtml(kicker)}</div>
			<h4><a href="${href}">${escapeHtml(g.title)}</a></h4>
		</article>`
		})
		.join('\n\t\t')

	const body = `<div class="method-page">
	<header class="masthead">
		<h1 class="masthead__title">${escapeHtml(opts.siteTitle)}</h1>
		<div class="masthead__tag">Development · The Method</div>
	</header>
	<div class="dateline">
		<span>Vol. I</span>
		<span>${escapeHtml(dateline)}</span>
		<span>${opts.chapters.length} chapter${opts.chapters.length === 1 ? '' : 's'}</span>
	</div>
	<section class="featured">
		<div class="featured__lead">
			<div class="kicker">${escapeHtml(featuredKicker)}</div>
			<h2><a href="${featuredHref}">${escapeHtml(featured.title)}</a></h2>
			<p>${escapeHtml(featuredDek)}</p>
		</div>
		<aside class="siblings">
			<h3>Also in Development</h3>
			<ul>
			${siblingsHtml || '<li><em>Nothing else yet.</em></li>'}
			</ul>
		</aside>
	</section>
	${grid.length > 0 ? `<section class="section-grid">\n\t\t${gridHtml}\n\t</section>` : ''}
</div>`

	return pageShell({
		title: opts.siteTitle,
		description: opts.siteDescription,
		chapterSlug: '',
		body,
	})
}

function renderChapter(opts: {
	siteTitle: string
	chapter: PublishableChapter
	chapterSlug: string
}): string {
	const dateFormatter = new Intl.DateTimeFormat('en-GB', {
		day: 'numeric',
		month: 'long',
		year: 'numeric',
	})
	const updated = dateFormatter.format(opts.chapter.updatedAt)
	const kicker = firstMetaString(opts.chapter.metadata, 'section') ?? 'Development'
	const body = renderMarkdownToHtml(opts.chapter.content)

	const shellBody = `<div class="method-page">
	<a class="article__back" href="/method/development">← Back to Development</a>
	<article class="article">
		<header>
			<div class="kicker">${escapeHtml(kicker)}</div>
			<h1>${escapeHtml(opts.chapter.title)}</h1>
			<div class="dateline">
				<span>${escapeHtml(opts.siteTitle)}</span>
				<span>${escapeHtml(updated)}</span>
			</div>
		</header>
		<div class="article__body">${body}</div>
		<footer>
			<span>${escapeHtml(opts.siteTitle)}</span>
			<a href="/method/development">Index →</a>
		</footer>
	</article>
</div>`

	return pageShell({
		title: `${opts.chapter.title} — ${opts.siteTitle}`,
		description: firstMetaString(opts.chapter.metadata, 'dek'),
		chapterSlug: opts.chapterSlug,
		body: shellBody,
	})
}

// ── Workspace resolution ────────────────────────────────────────────────────
//
// The method site is served from a single workspace per Hono instance —
// selected by `METHOD_WORKSPACE_ID` env, or the workspace whose settings
// carry `publish.enabled = true`. If no workspace opts in, we serve an
// empty cover (200) rather than a 404, so the surface probe still returns
// the shell.

async function resolveMethodWorkspace(db: Database): Promise<{
	id: string
	publish: PublishSettings
} | null> {
	const envId = process.env.METHOD_WORKSPACE_ID
	if (envId) {
		const [row] = await db
			.select({ id: workspaces.id, settings: workspaces.settings })
			.from(workspaces)
			.where(eq(workspaces.id, envId))
			.limit(1)
		if (!row) return null
		return { id: row.id, publish: readPublishSettings(row.settings) }
	}

	// No pinned workspace — pick the first with publish.enabled = true.
	// A workspace-scoped scan is fine at this scale (dozens of workspaces).
	const [row] = await db
		.select({ id: workspaces.id, settings: workspaces.settings })
		.from(workspaces)
		.where(sql`(workspaces.settings->'publish'->>'enabled')::boolean = true`)
		.limit(1)
	if (!row) return null
	return { id: row.id, publish: readPublishSettings(row.settings) }
}

// ── Routes ─────────────────────────────────────────────────────────────────

method.get('/development', async (c) => {
	const db = c.get('db')
	const workspace = await resolveMethodWorkspace(db)

	const siteTitle = workspace?.publish.title ?? 'Method'
	const siteDescription = workspace?.publish.description

	if (!workspace || !workspace.publish.enabled) {
		// Serve the shell so `/method/development` returns 200 (surface probe
		// requirement) even before a workspace opts in.
		const html = renderCover({ siteTitle, siteDescription, chapters: [] })
		c.header('Content-Type', 'text/html; charset=utf-8')
		c.header('Cache-Control', CACHE_CONTROL)
		return c.body(html)
	}

	const chapters = await loadPublishableChapters(db, workspace.id)
	const etag = coverEtag(chapters, workspace.publish.version ?? 0)

	if (c.req.header('If-None-Match') === etag) {
		c.header('ETag', etag)
		c.header('Cache-Control', CACHE_CONTROL)
		return c.body(null, 304)
	}

	const cached = cacheGet(etag)
	const html =
		cached ??
		renderCover({
			siteTitle,
			siteDescription,
			chapters,
		})
	if (!cached) cacheSet(etag, html)

	c.header('Content-Type', 'text/html; charset=utf-8')
	c.header('Cache-Control', CACHE_CONTROL)
	c.header('ETag', etag)
	return c.body(html)
})

method.get('/development/:slug', async (c) => {
	const db = c.get('db')
	const slug = c.req.param('slug')
	// Slug format guard — reject anything that couldn't have been minted here.
	// Prevents wildly-shaped inputs from spinning up a full workspace scan.
	if (!/^[a-z0-9-]{1,200}$/.test(slug)) {
		return c.notFound()
	}

	const workspace = await resolveMethodWorkspace(db)
	if (!workspace || !workspace.publish.enabled) {
		return c.notFound()
	}

	const chapters = await loadPublishableChapters(db, workspace.id)
	const chapter = chapters.find((ch) => slugFor(ch.id, ch.title) === slug)
	if (!chapter) return c.notFound()

	const etag = chapterEtag(chapter, workspace.publish.version ?? 0)

	if (c.req.header('If-None-Match') === etag) {
		c.header('ETag', etag)
		c.header('Cache-Control', CACHE_CONTROL)
		return c.body(null, 304)
	}

	const cached = cacheGet(etag)
	const siteTitle = workspace.publish.title ?? 'Method'
	const html =
		cached ??
		renderChapter({
			siteTitle,
			chapter,
			chapterSlug: slug,
		})
	if (!cached) cacheSet(etag, html)

	c.header('Content-Type', 'text/html; charset=utf-8')
	c.header('Cache-Control', CACHE_CONTROL)
	c.header('ETag', etag)
	return c.body(html)
})

// Explicit 404 for anything else under /method/* so the SPA fallthrough
// never claims the namespace.
method.get('*', (c) => c.notFound())

export default method
