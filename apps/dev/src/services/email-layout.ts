/**
 * email-layout.ts — the one look shared by the mails the app builds (summary, Flow activity,
 * notification), as pure functions that return HTML strings.
 *
 * Table-based, inline styles on every element, no scripts. The look is the Maskin brand email
 * (Design Studio's maskin-system-email template): logo and wordmark on top, a linen page, a card
 * with a blue top edge, one blue button and a quiet footer. One small <style> block carries only
 * what inline styles cannot: the dark-mode colours and the phone-width padding; a client that
 * drops it still shows the full light layout. Colours are the maskin.io brand tokens in light and
 * dark. The warning amber and success green are kept from the web app for their meaning.
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

const FONT =
	"'Schibsted Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"

// Brand tokens from maskin.io (light values here, dark values in the <style> block).
const C = {
	page: '#F0EDE7',
	card: '#FAFAF8',
	text: '#111110',
	muted: '#5A5751',
	border: '#E2DDD7',
	brand: '#2563EB',
	warning: '#8F5508',
	success: '#1B7F5A',
}

const LOGO_URL = 'https://maskin.io/apple-touch-icon.png'
const HOME_URL = 'https://maskin.io'
const FONT_URL =
	'https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;600;700&display=swap'

// Dark values: page #141412, card #1C1B18, ink #ECEAE4, muted #A09A93, rule #2A2925, accent #3B74F2.
// Inset blocks (waiting, next step, soft box) use the page colour, so they sit below the card.
const DARK_CSS = `
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
.m-page { background-color: #141412 !important; }
.m-card { background-color: #1C1B18 !important; border-color: #2A2925 !important; }
.m-text { color: #ECEAE4 !important; }
.m-muted { color: #A09A93 !important; }
.m-brand { color: #6B9BFF !important; }
.m-inset { background-color: #141412 !important; }
.m-next { border-left-color: #3B74F2 !important; }
.m-wait { border-left-color: #E8B03E !important; }
.m-tick { color: #4FD39A !important; }
.m-btn { background-color: #3B74F2 !important; }
.m-link { color: #A09A93 !important; }
.m-logo { border: 1px solid #2A2925 !important; }
}
@media only screen and (max-width: 620px) {
.m-pad { padding-left: 24px !important; padding-right: 24px !important; }
.m-big { font-size: 48px !important; }
}
`

/** A small coloured tick used to start each finished-run line. */
const TICK = '&#10003;'

export function headline(text: string): string {
	return `<h1 class="m-text" style="margin: 0; padding: 0 0 20px; font-family: ${FONT}; font-size: 28px; line-height: 34px; font-weight: 700; letter-spacing: -0.015em; color: ${C.text};">${escapeHtml(text)}</h1>`
}

/** The headline moment: how many things wait, big, with its label beside it. */
export function bigNumber(count: number, label: string): string {
	return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 20px;"><tr><td valign="middle" class="m-brand m-big" style="padding-right: 12px; font-family: ${FONT}; font-size: 56px; line-height: 56px; font-weight: 700; color: ${C.brand};">${count}</td><td valign="middle" class="m-text" style="font-family: ${FONT}; font-size: 22px; line-height: 28px; font-weight: 700; color: ${C.text};">${escapeHtml(label)}</td></tr></table>`
}

export function sectionHeading(text: string): string {
	return `<p class="m-muted" style="margin: 24px 0 8px; font-family: ${FONT}; font-size: 12px; line-height: 16px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: ${C.muted};">${escapeHtml(text)}</p>`
}

/** One waiting item as its own row with a coloured edge. */
export function waitingRow(text: string): string {
	return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 8px;"><tr><td class="m-wait m-inset m-text" style="padding: 12px 14px; background-color: ${C.page}; border-left: 3px solid ${C.warning}; border-radius: 4px; font-family: ${FONT}; font-size: 15px; line-height: 22px; color: ${C.text};">${escapeHtml(text)}</td></tr></table>`
}

/** Finished agent runs, one line each, with a small tick. */
export function tickList(lines: string[]): string {
	const rows = lines
		.map(
			(l) =>
				`<tr><td class="m-tick" valign="top" width="22" style="padding: 3px 0; font-family: ${FONT}; font-size: 14px; line-height: 22px; font-weight: 700; color: ${C.success};">${TICK}</td><td class="m-text" style="padding: 3px 0; font-family: ${FONT}; font-size: 15px; line-height: 22px; color: ${C.text};">${escapeHtml(l)}</td></tr>`,
		)
		.join('')
	return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 8px;">${rows}</table>`
}

/** The next step as one highlighted line. */
export function nextStepLine(text: string): string {
	return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 8px;"><tr><td class="m-next m-inset m-text" style="padding: 12px 14px; background-color: ${C.page}; border-left: 3px solid ${C.brand}; border-radius: 4px; font-family: ${FONT}; font-size: 15px; line-height: 22px; font-weight: 600; color: ${C.text};">${escapeHtml(text)}</td></tr></table>`
}

/** Secondary text (the onboarding lesson, the Marketplace pick) in a soft box; one line per entry. */
export function softBox(text: string | string[]): string {
	const lines = (Array.isArray(text) ? text : [text]).map(escapeHtml).join('<br>')
	return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 20px 0 0;"><tr><td class="m-inset m-muted" style="padding: 12px 14px; background-color: ${C.page}; border-radius: 6px; font-family: ${FONT}; font-size: 14px; line-height: 22px; color: ${C.muted};">${lines}</td></tr></table>`
}

/** Plain paragraph for the notification's own text. */
export function paragraph(text: string): string {
	return `<p class="m-text" style="margin: 0; padding: 0 0 16px; font-family: ${FONT}; font-size: 16px; line-height: 26px; color: ${C.text};">${escapeHtml(text)}</p>`
}

/** The one brand-coloured button. */
export function button(url: string, label: string): string {
	return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 8px 0;"><tr><td class="m-btn" bgcolor="${C.brand}" style="background-color: ${C.brand}; border-radius: 8px;"><a href="${escapeHtml(url)}" style="display: inline-block; padding: 13px 22px; font-family: ${FONT}; font-size: 16px; line-height: 20px; font-weight: 600; color: #FFFFFF; text-decoration: none;">${escapeHtml(label)}</a></td></tr></table>`
}

/** A quiet inline link. */
export function quietLink(url: string, label: string): string {
	return `<a class="m-link" href="${escapeHtml(url)}" style="color: ${C.muted}; text-decoration: underline;">${escapeHtml(label)}</a>`
}

/** A row of quiet links under a block, separated by a dot. */
export function linkRow(links: Array<{ url: string; label: string }>): string {
	return `<p class="m-muted" style="margin: 12px 0 0; font-family: ${FONT}; font-size: 14px; line-height: 22px; color: ${C.muted};">${links.map((l) => quietLink(l.url, l.label)).join(' &nbsp;&middot;&nbsp; ')}</p>`
}

export interface EmailLayoutInput {
	/** Hidden inbox preview line; should say something other than the subject. */
	preheader: string
	/** Block HTML from the helpers above, in reading order. */
	blocks: string[]
	/** Signed stop link for the footer. Left out for a mail about the account itself, which has no stop link. */
	stopUrl?: string
}

/**
 * Wraps the blocks in the shared page: linen background, the Maskin logo and wordmark, a card
 * about 600 px wide with a blue top edge, and a quiet footer with the stop link (none when
 * stopUrl is left out).
 */
export function renderEmail({ preheader, blocks, stopUrl }: EmailLayoutInput): string {
	// Padding after the preheader keeps the client from pulling body text into the inbox preview.
	const hidden = `<div style="display: none; max-height: 0; overflow: hidden; mso-hide: all; font-size: 1px; line-height: 1px; color: ${C.page};">${escapeHtml(preheader)}${'&nbsp;&zwnj;'.repeat(40)}</div>`
	const header = `<tr><td class="m-pad" style="padding: 0 8px 20px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle" style="padding-right: 10px;"><a href="${HOME_URL}" style="text-decoration: none;"><img class="m-logo" src="${LOGO_URL}" width="32" height="32" alt="Maskin" border="0" style="display: block; width: 32px; height: 32px; border: 0; border-radius: 7px;"></a></td><td valign="middle" style="font-family: ${FONT}; font-size: 20px; line-height: 24px; font-weight: 700; letter-spacing: -0.01em;"><a class="m-text" href="${HOME_URL}" style="color: ${C.text}; text-decoration: none;">Maskin</a></td></tr></table></td></tr>`
	const footer = `<tr><td class="m-pad m-muted" style="padding: 24px 8px 0; font-family: ${FONT}; font-size: 13px; line-height: 20px; color: ${C.muted};">${stopUrl ? `${quietLink(stopUrl, 'Stop these emails')}<br>` : ''}<a class="m-link" href="${HOME_URL}" style="color: ${C.muted}; text-decoration: underline;">maskin.io</a></td></tr>`
	return [
		'<!doctype html>',
		'<html lang="en">',
		'<head>',
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<meta name="color-scheme" content="light dark">',
		'<meta name="supported-color-schemes" content="light dark">',
		`<link href="${FONT_URL}" rel="stylesheet">`,
		`<style>${DARK_CSS}</style>`,
		'</head>',
		`<body class="m-page" style="margin: 0; padding: 0; background-color: ${C.page}; -webkit-text-size-adjust: 100%;">`,
		hidden,
		`<table role="presentation" class="m-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background-color: ${C.page};"><tr><td align="center" style="padding: 32px 12px;">`,
		'<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 600px;">',
		header,
		`<tr><td class="m-card" bgcolor="${C.card}" style="background-color: ${C.card}; border: 1px solid ${C.border}; border-radius: 12px;">`,
		'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">',
		`<tr><td class="m-btn" height="3" bgcolor="${C.brand}" style="height: 3px; line-height: 3px; font-size: 3px; background-color: ${C.brand}; border-top-left-radius: 12px; border-top-right-radius: 12px;">&nbsp;</td></tr>`,
		`<tr><td class="m-pad" style="padding: 36px 40px 32px;">${blocks.join('')}</td></tr>`,
		'</table>',
		'</td></tr>',
		footer,
		'</table>',
		'</td></tr></table>',
		'</body>',
		'</html>',
	].join('\n')
}
