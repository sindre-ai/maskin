import { Hono } from 'hono'

// THROWAWAY, never merge. Stands in for the real consent page for the live Claude smoke test
// (task 47b65564). GET /oauth/authorize shows one Approve button; POST approves for the throwaway
// tester account using its API key from SMOKE_STUB_API_KEY, then redirects back to Claude. Not
// mounted unless that variable is set. Staging only, tester account only.

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

app.get('/oauth/authorize', async (c) => {
	const key = process.env.SMOKE_STUB_API_KEY
	if (!key) return c.text('Not found', 404)
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
	const key = process.env.SMOKE_STUB_API_KEY
	if (!key) return c.text('Not found', 404)
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

export default app
