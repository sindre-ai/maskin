import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { _resetFeatureFlagConfig } from '../lib/feature-flags'

// THROWAWAY, never merge. Stands in for the real consent page for the live Claude smoke test
// (task 47b65564). GET /oauth/authorize shows one Approve button; POST approves for a throwaway
// tester account that this file creates on first use (in memory, nothing stored), lists in the
// tester flag, then redirects back to Claude. Staging only, deleted once the verdict is in.

const app = new Hono()

const PARAMS = [
	'response_type',
	'client_id',
	'redirect_uri',
	'code_challenge',
	'code_challenge_method',
	'state',
	'resource',
	'scope',
] as const

const esc = (s: string) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const page = (body: string) =>
	`<!doctype html><meta charset="utf-8"><title>Maskin smoke consent (stub)</title><body style="font-family:sans-serif;max-width:32rem;margin:3rem auto">${body}</body>`

const api = (path: string) => `http://localhost:${process.env.PORT ?? 3000}${path}`

type Tester = { id: string; key: string }
let tester: Promise<Tester> | null = null

// Signs up the tester through the public route, then lists it as a flag tester. The flag config
// is read once and kept, so it is reset after the env changes.
function getTester(): Promise<Tester> {
	if (!tester) {
		tester = (async () => {
			const res = await fetch(api('/api/actors'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					type: 'human',
					name: 'Smoke Stub Tester',
					email: `smoke-stub-${randomUUID().slice(0, 8)}@maskin.io`,
					password: `${randomUUID()}${randomUUID()}`,
				}),
			})
			const a = (await res.json()) as { id?: string; api_key?: string }
			if (!res.ok || !a.id || !a.api_key) throw new Error(`tester signup failed: ${res.status}`)
			process.env.FF_TESTER_ACTOR_IDS = [process.env.FF_TESTER_ACTOR_IDS, a.id]
				.filter(Boolean)
				.join(',')
			process.env.FF_TESTER_FEATURES = process.env.FF_TESTER_FEATURES || 'mcp-oauth-consent'
			_resetFeatureFlagConfig()
			return { id: a.id, key: a.api_key }
		})()
		tester.catch(() => {
			tester = null
		})
	}
	return tester
}

app.get('/oauth/authorize', async (c) => {
	const { key } = await getTester()
	const q = c.req.query()
	const qs = new URLSearchParams()
	for (const k of PARAMS) if (q[k] !== undefined) qs.set(k, q[k])

	const res = await fetch(api(`/api/oauth/authorize/preview?${qs}`), {
		headers: { Authorization: `Bearer ${key}` },
	})
	const out = (await res.json()) as {
		client?: { client_name: string; redirect_host: string }
		workspaces?: { id: string; name: string }[]
	}
	if (!res.ok || !out.workspaces?.[0]) {
		return c.html(page(`<h1>Refused</h1><pre>${esc(JSON.stringify(out, null, 2))}</pre>`), 400)
	}
	const hidden = PARAMS.filter((k) => q[k] !== undefined)
		.map((k) => `<input type="hidden" name="${k}" value="${esc(q[k] as string)}">`)
		.join('')
	const ws = out.workspaces[0]
	return c.html(
		page(
			`<h1>Stub consent</h1><p>${esc(out.client?.client_name ?? '')} (returns to ${esc(
				out.client?.redirect_host ?? '',
			)}) wants to connect to workspace <b>${esc(ws.name)}</b>.</p>` +
				`<form method="post" action="/oauth/authorize/stub">${hidden}` +
				`<input type="hidden" name="workspace_id" value="${esc(ws.id)}">` +
				'<button type="submit">Approve</button></form>',
		),
	)
})

app.post('/oauth/authorize/stub', async (c) => {
	const { key } = await getTester()
	const form = await c.req.parseBody()
	const body: Record<string, string> = {}
	for (const k of [...PARAMS, 'workspace_id']) {
		if (typeof form[k] === 'string') body[k] = form[k] as string
	}
	const res = await fetch(api('/api/oauth/authorize/approve'), {
		method: 'POST',
		headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
	const out = (await res.json()) as { redirect_url?: string }
	if (!res.ok || !out.redirect_url) {
		return c.html(page(`<h1>Refused</h1><pre>${esc(JSON.stringify(out, null, 2))}</pre>`), 400)
	}
	return c.redirect(out.redirect_url, 302)
})

// The tester's connections, and a way to end one, so the smoke test can try "we revoke" without
// the tester's key ever leaving the process.
app.get('/oauth/authorize/stub-grants', async (c) => {
	const { key } = await getTester()
	const res = await fetch(api('/api/oauth/grants'), { headers: { Authorization: `Bearer ${key}` } })
	return c.json(await res.json(), res.status as 200)
})

app.post('/oauth/authorize/stub-revoke/:id', async (c) => {
	const { key } = await getTester()
	const res = await fetch(api(`/api/oauth/grants/${c.req.param('id')}`), {
		method: 'DELETE',
		headers: { Authorization: `Bearer ${key}` },
	})
	return c.json(await res.json(), res.status as 200)
})

export default app
