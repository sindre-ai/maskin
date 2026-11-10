import type { Database } from '@maskin/db'
import { notificationPreferences } from '@maskin/db/schema'
import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { verifyEmailPickToken } from '../lib/email-pick-token'
import { logger } from '../lib/logger'

// The "Not useful" link under a Marketplace pick in a summary email. Public: nobody is signed in
// when they tap it, so the signed token in the link is the only credential
// (lib/email-pick-token.ts). GET shows a confirm page and changes nothing, so a mail scanner that
// opens the link cannot dismiss anything. POST adds that one flow to the person's dismissed list;
// it is never suggested to them again. Plain HTML, not part of the OpenAPI spec.

type Env = { Variables: { db: Database } }

const app = new Hono<Env>()

const PAGE_HEADERS = {
	'Content-Type': 'text/html; charset=utf-8',
	'Cache-Control': 'no-store',
	'Referrer-Policy': 'no-referrer',
	'X-Frame-Options': 'DENY',
	'Content-Security-Policy':
		"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
}

function escapeHtml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
}

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f6f6;color:#111}main{max-width:420px;margin:24px;padding:32px;background:#fff;border-radius:16px}h1{font-size:20px;margin:0 0 8px}p{margin:0 0 20px;color:#555}button{font:inherit;font-weight:600;padding:12px 20px;border:0;border-radius:999px;background:#111;color:#fff;cursor:pointer}</style>
</head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`
}

function html(status: number, content: string): Response {
	return new Response(content, { status, headers: PAGE_HEADERS })
}

function refusal(reason: 'unconfigured' | 'invalid' | 'expired') {
	if (reason === 'unconfigured') {
		return {
			status: 503,
			title: 'This link can’t be used right now',
			text: 'Nothing was changed. You can switch Marketplace picks off in Settings, then Notifications.',
		}
	}
	return {
		status: 400,
		title: reason === 'expired' ? 'This link has expired' : 'This link doesn’t work',
		text: 'Nothing was changed. You can switch Marketplace picks off in Settings, then Notifications.',
	}
}

app.get('/', (c) => {
	const token = c.req.query('token') ?? ''
	const verdict = verifyEmailPickToken(token)
	if (!verdict.ok) {
		const r = refusal(verdict.reason)
		return html(r.status, page(r.title, `<p>${escapeHtml(r.text)}</p>`))
	}
	return html(
		200,
		page(
			'Not useful?',
			`<p>We won’t suggest this flow to you again. You can switch Marketplace picks off in Settings, then Notifications.</p><form method="post" action="/api/email/pick-dismiss"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">Not useful</button></form>`,
		),
	)
})

app.post('/', async (c) => {
	let token = c.req.query('token') ?? ''
	if (!token) {
		const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
		token = typeof form.token === 'string' ? form.token : ''
	}
	const verdict = verifyEmailPickToken(token)
	if (!verdict.ok) {
		const r = refusal(verdict.reason)
		return html(r.status, page(r.title, `<p>${escapeHtml(r.text)}</p>`))
	}

	try {
		// Only the person's own row, and only once per flow.
		await c.get('db').execute(sql`
			UPDATE ${notificationPreferences}
			SET marketplace_dismissed_loop_ids = array_append(marketplace_dismissed_loop_ids, ${verdict.loopId}::uuid),
				updated_at = now()
			WHERE actor_id = ${verdict.actorId}
				AND NOT (${verdict.loopId}::uuid = ANY(marketplace_dismissed_loop_ids))`)
	} catch (err) {
		logger.error('email pick dismissal failed to save', { error: String(err) })
		return html(
			500,
			page('Something went wrong', '<p>Nothing was changed. Please try the link again.</p>'),
		)
	}
	return html(200, page('Got it', '<p>We won’t suggest this flow to you again.</p>'))
})

export default app
