// AC-T2: an agent in the browser sidecar must be able to navigate to a
// Vercel preview deployment with the `x-vercel-protection-bypass` header
// and `x-vercel-set-bypass-cookie=true`, then keep the resulting bypass
// cookie alive across subsequent in-browser navigations so the preview
// continues to serve authenticated responses.
//
// We don't have a real preview deployment under our control in CI, so this
// test runs against a local fixture HTTP server that mimics Vercel's
// protection-bypass contract: a request that arrives with a valid bypass
// header + the set-cookie hint receives a `_vercel_jwt` cookie; subsequent
// requests are authorised via the cookie alone.
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'

const BYPASS_SECRET = 'fixture-bypass-secret-bf28a1'
const BYPASS_COOKIE = '_vercel_jwt'

function startVercelLikePreview(): Promise<{ server: Server; url: string }> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			const cookies = parseCookies(req.headers.cookie)
			const bypassHeader = req.headers['x-vercel-protection-bypass']
			const setCookieHint = req.headers['x-vercel-set-bypass-cookie']
			const hasCookie = cookies[BYPASS_COOKIE] === BYPASS_SECRET
			const hasValidHeader = bypassHeader === BYPASS_SECRET

			// Either auth path is acceptable — header on first nav, cookie on
			// subsequent ones. Anything else is a 401, mimicking what an agent
			// without the bypass would see on a Vercel preview.
			if (!hasCookie && !hasValidHeader) {
				res.writeHead(401, { 'content-type': 'application/json' })
				res.end(JSON.stringify({ error: 'preview_protected' }))
				return
			}

			// First-nav contract: when the agent passes the set-cookie hint and a
			// valid bypass header, the preview echoes the cookie back so the
			// browser carries it on the next navigation.
			const responseHeaders: Record<string, string | string[]> = {
				'content-type': 'text/html; charset=utf-8',
			}
			if (hasValidHeader && setCookieHint === 'true') {
				responseHeaders['set-cookie'] =
					`${BYPASS_COOKIE}=${BYPASS_SECRET}; Path=/; HttpOnly; SameSite=Lax`
			}

			if (req.url === '/api/me') {
				res.writeHead(200, { ...responseHeaders, 'content-type': 'application/json' })
				res.end(JSON.stringify({ authenticated: true, via: hasValidHeader ? 'header' : 'cookie' }))
				return
			}

			// Default page: a tiny HTML doc with an internal link so we can drive
			// the second-nav assertion via a click rather than a synthetic goto.
			res.writeHead(200, responseHeaders)
			res.end(
				'<!doctype html><html><body><h1>Preview</h1>' +
					'<a id="me-link" href="/api/me">Me</a></body></html>',
			)
		})
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as AddressInfo
			resolve({ server, url: `http://127.0.0.1:${port}` })
		})
	})
}

function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {}
	if (!header) return out
	for (const part of header.split(';')) {
		const idx = part.indexOf('=')
		if (idx === -1) continue
		const k = part.slice(0, idx).trim()
		const v = part.slice(idx + 1).trim()
		if (k) out[k] = v
	}
	return out
}

test.describe('Vercel preview bypass — AC-T2', () => {
	let server: Server
	let baseUrl: string

	test.beforeAll(async () => {
		const started = await startVercelLikePreview()
		server = started.server
		baseUrl = started.url
	})

	test.afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()))
	})

	test('first navigation with bypass header sets the cookie; subsequent in-browser nav stays authenticated', async ({
		browser,
	}) => {
		const context = await browser.newContext({
			extraHTTPHeaders: {
				'x-vercel-protection-bypass': BYPASS_SECRET,
				'x-vercel-set-bypass-cookie': 'true',
			},
		})
		const page = await context.newPage()

		// First request — /api/me with bypass header should return 200 and set
		// the `_vercel_jwt` bypass cookie on the browser context.
		const firstResponse = await page.goto(`${baseUrl}/api/me`)
		expect(firstResponse?.status()).toBe(200)
		const firstBody = (await firstResponse?.json()) as { authenticated: boolean; via: string }
		expect(firstBody.authenticated).toBe(true)
		expect(firstBody.via).toBe('header')

		const cookies = await context.cookies()
		const bypassCookie = cookies.find((c) => c.name === BYPASS_COOKIE)
		expect(bypassCookie?.value).toBe(BYPASS_SECRET)

		// Now strip the bypass header — subsequent navigations should rely on
		// the cookie alone, which is exactly what an in-browser click does on a
		// real Vercel preview.
		await context.setExtraHTTPHeaders({})

		// Land on the preview's HTML page, then click an internal link.
		await page.goto(`${baseUrl}/`)
		const secondResponsePromise = page.waitForResponse(`${baseUrl}/api/me`)
		await page.click('#me-link')
		const secondResponse = await secondResponsePromise

		expect(secondResponse.status()).toBe(200)
		const secondBody = (await secondResponse.json()) as { authenticated: boolean; via: string }
		expect(secondBody.authenticated).toBe(true)
		expect(secondBody.via).toBe('cookie')

		await context.close()
	})

	test('preview without the bypass header or cookie returns 401', async ({ browser }) => {
		const context = await browser.newContext()
		const page = await context.newPage()
		const response = await page.goto(`${baseUrl}/api/me`)
		expect(response?.status()).toBe(401)
		await context.close()
	})
})
