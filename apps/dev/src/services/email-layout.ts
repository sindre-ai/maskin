/**
 * email-layout.ts — the one look shared by the mails the app builds (summary, Flow activity,
 * notification), as pure functions that return HTML strings.
 *
 * Table-based, inline styles on every element, no scripts and no hosted images. One small <style>
 * block carries only the two things inline styles cannot: the dark-mode colours and the phone-width
 * padding; a client that drops it still shows the full light layout. Colours are the web app theme
 * tokens (`brand`, `warning`, `success`, `muted`, `border`) in their light and dark values.
 */

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

/**
 * Cuts text at a word boundary with an ellipsis, so a line never ends mid-word. Whitespace is
 * collapsed first. A single word longer than the limit is the one case that is cut inside the word.
 */
export function clipAtWord(text: string, max: number): string {
	const t = text.replace(/\s+/g, ' ').trim()
	if (t.length <= max) return t
	const head = t.slice(0, max - 1)
	// The cut already falls on a space: the last word is whole.
	const lastSpace = t[max - 1] === ' ' ? head.length : head.lastIndexOf(' ')
	const cut = lastSpace > 0 ? head.slice(0, lastSpace) : head
	return `${cut.replace(/[\s,;:.\-–—]+$/, '')}…`
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

// Light values from the web app theme (`apps/web/src/app.css`), dark values in the <style> block.
const C = {
	page: '#eef0f4',
	card: '#ffffff',
	text: '#10131a',
	muted: '#5a6372',
	border: '#e5e8ec',
	brand: '#2545c8',
	brandSoft: '#e8edfb',
	brandSoftText: '#1b36a0',
	soft: '#eef0f4',
	warning: '#8f5508',
	success: '#1b7f5a',
}

const DARK_CSS = `
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
.m-page { background-color: #0d0f13 !important; }
.m-card { background-color: #12151a !important; border-color: #23272e !important; }
.m-strip { background-color: #1c2339 !important; }
.m-strip-text { color: #a9bcff !important; }
.m-text { color: #e8eaee !important; }
.m-muted { color: #8a93a0 !important; }
.m-brand { color: #6a8cff !important; }
.m-soft { background-color: #181b21 !important; }
.m-next { background-color: #1c2339 !important; color: #a9bcff !important; border-left-color: #6a8cff !important; }
.m-wait { background-color: #181b21 !important; border-left-color: #e8b03e !important; }
.m-tick { color: #4fd39a !important; }
.m-btn { background-color: #6a8cff !important; border-color: #6a8cff !important; }
.m-btn-text { color: #060b1f !important; }
.m-link { color: #8a93a0 !important; }
}
@media only screen and (max-width: 480px) {
.m-pad { padding-left: 16px !important; padding-right: 16px !important; }
.m-outer { padding: 0 !important; }
.m-big { font-size: 48px !important; }
}
`

/** A small coloured tick used to start each finished-run line. */
const TICK = '&#10003;'

export function headline(text: string): string {
	return `<p class="m-text" style="margin: 0 0 16px; font-family: ${FONT}; font-size: 22px; line-height: 28px; font-weight: 700; color: ${C.text};">${escapeHtml(text)}</p>`
}

/** The headline moment: how many things wait, big, with its label beside it. */
export function bigNumber(count: number, label: string): string {
	return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 20px;"><tr><td valign="middle" class="m-brand m-big" style="padding-right: 12px; font-family: ${FONT}; font-size: 56px; line-height: 56px; font-weight: 800; color: ${C.brand};">${count}</td><td valign="middle" class="m-text" style="font-family: ${FONT}; font-size: 20px; line-height: 26px; font-weight: 600; color: ${C.text};">${escapeHtml(label)}</td></tr></table>`
}

export function sectionHeading(text: string): string {
	return `<p class="m-muted" style="margin: 20px 0 8px; font-family: ${FONT}; font-size: 12px; line-height: 16px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: ${C.muted};">${escapeHtml(text)}</p>`
}

/** One waiting item as its own row with a coloured edge. */
export function waitingRow(text: string): string {
	return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 8px;"><tr><td class="m-wait m-text" style="padding: 12px 14px; background-color: ${C.soft}; border-left: 4px solid ${C.warning}; border-radius: 4px; font-family: ${FONT}; font-size: 15px; line-height: 21px; color: ${C.text};">${escapeHtml(text)}</td></tr></table>`
}

/** Finished agent runs, one line each, with a small tick. */
export function tickList(lines: string[]): string {
	const rows = lines
		.map(
			(l) =>
				`<tr><td class="m-tick" valign="top" width="22" style="padding: 3px 0; font-family: ${FONT}; font-size: 14px; line-height: 21px; font-weight: 700; color: ${C.success};">${TICK}</td><td class="m-text" style="padding: 3px 0; font-family: ${FONT}; font-size: 15px; line-height: 21px; color: ${C.text};">${escapeHtml(l)}</td></tr>`,
		)
		.join('')
	return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 8px;">${rows}</table>`
}

/** The next step as one highlighted line. */
export function nextStepLine(text: string): string {
	return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 8px;"><tr><td class="m-next" style="padding: 12px 14px; background-color: ${C.brandSoft}; border-left: 4px solid ${C.brand}; border-radius: 4px; font-family: ${FONT}; font-size: 15px; line-height: 21px; font-weight: 600; color: ${C.brandSoftText};">${escapeHtml(text)}</td></tr></table>`
}

/** Secondary text (the onboarding lesson, the Marketplace pick) in a soft box; one line per entry. */
export function softBox(text: string | string[]): string {
	const lines = (Array.isArray(text) ? text : [text]).map(escapeHtml).join('<br>')
	return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 20px 0 0;"><tr><td class="m-soft m-muted" style="padding: 12px 14px; background-color: ${C.soft}; border-radius: 6px; font-family: ${FONT}; font-size: 14px; line-height: 20px; color: ${C.muted};">${lines}</td></tr></table>`
}

/** Plain paragraph for the notification's own text. */
export function paragraph(text: string): string {
	return `<p class="m-text" style="margin: 0 0 8px; font-family: ${FONT}; font-size: 15px; line-height: 22px; color: ${C.text};">${escapeHtml(text)}</p>`
}

/** The one brand-coloured button. */
export function button(url: string, label: string): string {
	return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0 0;"><tr><td class="m-btn" bgcolor="${C.brand}" style="background-color: ${C.brand}; border-radius: 6px;"><a class="m-btn-text" href="${escapeHtml(url)}" style="display: inline-block; padding: 13px 24px; font-family: ${FONT}; font-size: 16px; line-height: 20px; font-weight: 600; color: #ffffff; text-decoration: none;">${escapeHtml(label)}</a></td></tr></table>`
}

/** A quiet inline link. */
export function quietLink(url: string, label: string): string {
	return `<a class="m-link" href="${escapeHtml(url)}" style="color: ${C.muted}; text-decoration: underline;">${escapeHtml(label)}</a>`
}

/** A row of quiet links under a block, separated by a dot. */
export function linkRow(links: Array<{ url: string; label: string }>): string {
	return `<p class="m-muted" style="margin: 10px 0 0; font-family: ${FONT}; font-size: 14px; line-height: 20px; color: ${C.muted};">${links.map((l) => quietLink(l.url, l.label)).join(' &nbsp;&middot;&nbsp; ')}</p>`
}

export interface EmailLayoutInput {
	/** Hidden inbox preview line; should say something other than the subject. */
	preheader: string
	/** Block HTML from the helpers above, in reading order. */
	blocks: string[]
	/** Signed stop link for the footer. */
	stopUrl: string
}

/**
 * Wraps the blocks in the shared page: grey background, a branded strip with the Maskin name, a
 * white card about 560 px wide, and a quiet footer with the stop link.
 */
export function renderEmail({ preheader, blocks, stopUrl }: EmailLayoutInput): string {
	// Padding after the preheader keeps the client from pulling body text into the inbox preview.
	const hidden = `<div style="display: none; max-height: 0; overflow: hidden; mso-hide: all; font-size: 1px; line-height: 1px; color: ${C.page};">${escapeHtml(preheader)}${'&nbsp;&zwnj;'.repeat(40)}</div>`
	return [
		'<!doctype html>',
		'<html lang="en">',
		'<head>',
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<meta name="color-scheme" content="light dark">',
		'<meta name="supported-color-schemes" content="light dark">',
		`<style>${DARK_CSS}</style>`,
		'</head>',
		`<body class="m-page" style="margin: 0; padding: 0; background-color: ${C.page};">`,
		hidden,
		`<table role="presentation" class="m-page" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: ${C.page};"><tr><td align="center" class="m-outer" style="padding: 24px 12px;">`,
		`<table role="presentation" class="m-card" width="560" cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 560px; background-color: ${C.card}; border: 1px solid ${C.border}; border-radius: 8px; overflow: hidden;">`,
		`<tr><td class="m-strip m-pad" style="padding: 14px 24px; background-color: ${C.brand};"><span class="m-strip-text" style="font-family: ${FONT}; font-size: 16px; line-height: 20px; font-weight: 700; letter-spacing: 0.02em; color: #ffffff;">Maskin</span></td></tr>`,
		`<tr><td class="m-pad" style="padding: 28px 24px 8px;">${blocks.join('')}</td></tr>`,
		`<tr><td class="m-pad" style="padding: 8px 24px 24px;"><p class="m-muted" style="margin: 16px 0 0; font-family: ${FONT}; font-size: 13px; line-height: 18px; color: ${C.muted};">${quietLink(stopUrl, 'Stop these emails')}</p></td></tr>`,
		'</table>',
		'</td></tr></table>',
		'</body>',
		'</html>',
	].join('\n')
}
