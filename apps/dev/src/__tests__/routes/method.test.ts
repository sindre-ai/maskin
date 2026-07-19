import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { METHOD_SITE_PAGEVIEW_EVENT } from '../../lib/analytics/method-site-pageview'
import methodRoutes from '../../routes/method'

function mount() {
	const app = new Hono()
	app.route('/method', methodRoutes)
	return app
}

const originalKey = process.env.VITE_POSTHOG_KEY
const originalHost = process.env.VITE_POSTHOG_HOST

function restore(name: 'VITE_POSTHOG_KEY' | 'VITE_POSTHOG_HOST', value: string | undefined) {
	if (value === undefined) Reflect.deleteProperty(process.env, name)
	else process.env[name] = value
}

beforeEach(() => {
	process.env.VITE_POSTHOG_KEY = 'phc_test_key'
	process.env.VITE_POSTHOG_HOST = 'https://eu.i.posthog.com'
})

afterEach(() => {
	restore('VITE_POSTHOG_KEY', originalKey)
	restore('VITE_POSTHOG_HOST', originalHost)
})

describe('GET /method/development', () => {
	it('returns 200 HTML with the pageview snippet inlined', async () => {
		const app = mount()
		const res = await app.request('/method/development')
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('text/html')
		const body = await res.text()
		expect(body).toContain(METHOD_SITE_PAGEVIEW_EVENT)
		expect(body).toContain('posthog.init(')
		expect(body).toContain('posthog.capture(')
	})
})

describe('GET /method/development/:slug', () => {
	it('inlines the slug as a JSON literal into the emit call', async () => {
		const app = mount()
		const res = await app.request('/method/development/loops')
		expect(res.status).toBe(200)
		const body = await res.text()
		expect(body).toContain('"loops"')
		expect(body).toContain('chapter_slug:')
	})

	it('escapes hostile slugs so they cannot break out of either the script or the HTML body', async () => {
		const app = mount()
		const res = await app.request('/method/development/%3Cscript%3Ealert(1)%3C%2Fscript%3E')
		const body = await res.text()
		// Body escape: the article <h1> uses escapeHtml, so the raw tags never
		// reach the DOM.
		expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
		// Script escape: the analytics snippet inlines the slug as a JSON
		// literal with `<` → `\u003c`, so a `</script>` inside the slug can't
		// close the wrapper script tag.
		expect(body).toContain('\\u003cscript>alert(1)\\u003c/script>')
	})

	it('degrades to a no-op script when VITE_POSTHOG_KEY is unset', async () => {
		Reflect.deleteProperty(process.env, 'VITE_POSTHOG_KEY')
		const app = mount()
		const res = await app.request('/method/development/loops')
		expect(res.status).toBe(200)
		const body = await res.text()
		expect(body).toContain(METHOD_SITE_PAGEVIEW_EVENT)
		expect(body).not.toContain('posthog.init(')
	})
})
