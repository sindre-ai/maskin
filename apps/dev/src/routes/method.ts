import { Hono } from 'hono'
import { buildMethodSitePageviewScript } from '../lib/analytics/method-site-pageview'

// Public reader shell for the Maskin Method site. This module is the mount
// point for `/method/*` — the analytics injection in the `<head>` is what
// makes the bet's ship metric (`method_site_pageview`) measurable, so if the
// editorial layer is rebuilt on top of this route, keep the
// `buildMethodSitePageviewScript()` call site.
const methodRoutes = new Hono()

function renderShell(chapterSlug: string, body: string): string {
	const analyticsScript = buildMethodSitePageviewScript({
		apiKey: process.env.VITE_POSTHOG_KEY,
		apiHost: process.env.VITE_POSTHOG_HOST,
		chapterSlug,
	})
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Maskin Method — Development</title>
${analyticsScript}
</head>
<body>
${body}
</body>
</html>`
}

methodRoutes.get('/development', (c) => {
	return c.html(renderShell('', '<main><h1>Development</h1></main>'))
})

methodRoutes.get('/development/:slug', (c) => {
	const slug = c.req.param('slug')
	return c.html(renderShell(slug, `<article><h1>${escapeHtml(slug)}</h1></article>`))
})

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

export default methodRoutes
