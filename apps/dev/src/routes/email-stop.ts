import type { Database } from '@maskin/db'
import { actors } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { verifyEmailStopToken } from '../lib/email-stop-token'
import { logger } from '../lib/logger'
import {
	switchEmailKindOff,
	switchEmailOff,
	trackEmailSwitchedOff,
} from '../services/email-preferences'

// The "stop these emails" link in a summary email. Public: nobody is signed in when they tap it,
// so the signed token in the link is the only credential (lib/email-stop-token.ts). GET shows a
// confirm page and changes nothing, so a mail scanner that opens the link cannot switch email off.
// POST does the change; it also answers the one-click List-Unsubscribe-Post that mail apps send
// to the same URL. Plain HTML, not part of the OpenAPI spec.

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
			text: 'Please switch email off in Settings, then Notifications.',
		}
	}
	return {
		status: 400,
		title: reason === 'expired' ? 'This link has expired' : 'This link doesn’t work',
		text: 'Nothing was changed. You can switch email off in Settings, then Notifications.',
	}
}

/** What the link stops, in the words of the confirm page. A kind-scoped link names only that kind. */
const KIND_WORDS: Record<string, { what: string; title: string }> = {
	flow_activity: { what: 'flow activity emails', title: 'Stop flow activity emails?' },
	needs_you: { what: 'emails about things that need you', title: 'Stop these emails?' },
	conversation: { what: 'emails about chat replies', title: 'Stop chat reply emails?' },
	tips: { what: 'tips and updates emails', title: 'Stop tips emails?' },
}

app.get('/', (c) => {
	const token = c.req.query('token') ?? ''
	const verdict = verifyEmailStopToken(token)
	if (!verdict.ok) {
		const r = refusal(verdict.reason)
		return html(r.status, page(r.title, `<p>${escapeHtml(r.text)}</p>`))
	}
	const words = verdict.kind ? KIND_WORDS[verdict.kind] : null
	if (verdict.kind && !words) {
		const r = refusal('invalid')
		return html(r.status, page(r.title, `<p>${escapeHtml(r.text)}</p>`))
	}
	return html(
		200,
		page(
			words?.title ?? 'Stop summary emails?',
			`<p>You will stop getting the ${words?.what ?? 'summary emails'} from Maskin. You can switch them back on in Settings.</p><form method="post" action="/api/email/stop"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">Stop emails</button></form>`,
		),
	)
})

app.post('/', async (c) => {
	let token = c.req.query('token') ?? ''
	if (!token) {
		const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
		token = typeof form.token === 'string' ? form.token : ''
	}
	const verdict = verifyEmailStopToken(token)
	if (!verdict.ok) {
		const r = refusal(verdict.reason)
		return html(r.status, page(r.title, `<p>${escapeHtml(r.text)}</p>`))
	}

	const db = c.get('db')
	const [actor] = await db
		.select({ id: actors.id })
		.from(actors)
		.where(eq(actors.id, verdict.actorId))
		.limit(1)
	if (!actor) {
		const r = refusal('invalid')
		return html(r.status, page(r.title, `<p>${escapeHtml(r.text)}</p>`))
	}

	const words = verdict.kind ? KIND_WORDS[verdict.kind] : null
	if (verdict.kind && !words) {
		const r = refusal('invalid')
		return html(r.status, page(r.title, `<p>${escapeHtml(r.text)}</p>`))
	}

	try {
		// A kind-scoped link switches off that kind only; the summary keeps going.
		const changed = verdict.kind
			? await switchEmailKindOff(db, actor.id, verdict.kind)
			: await switchEmailOff(db, actor.id)
		if (changed) trackEmailSwitchedOff(actor.id, 'link', verdict.kind ?? undefined)
	} catch (err) {
		logger.error('email stop link failed to save', { error: String(err) })
		return html(
			500,
			page('Something went wrong', '<p>Nothing was changed. Please try the link again.</p>'),
		)
	}
	return html(
		200,
		page(
			'Emails stopped',
			`<p>You won’t get ${words?.what ?? 'summary emails'} from Maskin any more. You can switch them back on in Settings, then Notifications.</p>`,
		),
	)
})

export default app
