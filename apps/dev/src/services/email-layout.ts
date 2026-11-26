/**
 * email-layout.ts — the one look shared by the mails the app builds (summary, Flow activity,
 * notification), as pure functions that return HTML strings.
 *
 * Table-based, inline styles on every element, no scripts. The look is the Maskin brand email
 * (Design Studio's maskin-system-email template): logo and wordmark on top, a grey page, a white
 * card with a hairline border, one cobalt button and a quiet footer. One small <style> block
 * carries only what inline styles cannot: the dark-mode colours and the phone-width padding; a
 * client that drops it still shows the full light layout. Colours are the web app's own tokens
 * (apps/web/src/app.css), light in the inline styles and dark in the <style> block.
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

// The web app's tokens (apps/web/src/app.css), light values here, dark values in the <style> block.
const C = {
	page: '#f6f7f9',
	card: '#ffffff',
	text: '#10131a',
	muted: '#5a6372',
	border: '#e5e8ec',
	hairline: '#eef0f4',
	warning: '#8f5508',
	success: '#166a49',
	successFill: '#dff1e8',
}

/**
 * The main button, in one place: near-black in light mode (the web app's ink), and the light ink
 * on the dark card in dark mode, so it stays the strongest thing in the mail either way.
 * `bg` and `text` are light mode, `darkBg` and `darkText` are dark mode. Nothing else in
 * this file names the button colour.
 */
export const MAIN_BUTTON = {
	bg: '#10131a',
	text: '#ffffff',
	darkBg: '#e8eaee',
	darkText: '#0d0f13',
}

const LOGO_URL = 'https://maskin.io/apple-touch-icon.png'
const HOME_URL = 'https://maskin.io'
const FONT_URL =
	'https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;600;700&display=swap'

// Dark values: page #0d0f13, card #12151a, border #23272e, ink #e8eaee, muted #8a93a0,
// hairline #1a1d23. Soft boxes use the page colour. The button's dark colours are MAIN_BUTTON's.
const DARK_CSS = `
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
.m-page { background-color: #0d0f13 !important; }
.m-card { background-color: #12151a !important; border-color: #23272e !important; }
.m-text { color: #e8eaee !important; }
.m-muted { color: #8a93a0 !important; }
.m-box { background-color: #0d0f13 !important; border-color: #23272e !important; }
.m-rule { border-color: #1a1d23 !important; }
.m-wait { color: #e8b03e !important; }
.m-tick { background-color: #022c22 !important; color: #4fd39a !important; }
.m-btn { background-color: ${MAIN_BUTTON.darkBg} !important; }
.m-btn-text { color: ${MAIN_BUTTON.darkText} !important; }
.m-mini { border-color: #373d47 !important; color: #e8eaee !important; }
.m-boxrule { border-color: #23272e !important; }
.m-chip-bet { background-color: #1c2339 !important; color: #a9bcff !important; }
.m-chip-task { background-color: #181b21 !important; color: #8a93a0 !important; }
.m-chip-flow { background-color: #4a044e !important; color: #f0abfc !important; }
.m-chip-chat { background-color: #164e63 !important; color: #a5f3fc !important; }
.m-chip-insight { background-color: #422006 !important; color: #fbbf24 !important; }
.m-link { color: #8a93a0 !important; }
.m-logo { border: 1px solid #23272e !important; }
}
@media only screen and (max-width: 620px) {
.m-pad { padding-left: 22px !important; padding-right: 22px !important; }
.m-h1 { font-size: 24px !important; line-height: 30px !important; }
.m-big { font-size: 26px !important; }
}
`

/** A small tick used to start each finished-run line. */
const TICK = '&#10003;'

/** The soft box shared by waiting, next step and the secondary text: page-colour fill, hairline border. */
const BOX = `background-color: ${C.page}; border: 1px solid ${C.border}; border-radius: 12px;`

export function headline(text: string): string {
	return `<h1 class="m-h1 m-text" style="margin: 0; padding: 0 0 18px; font-family: ${FONT}; font-size: 28px; line-height: 34px; font-weight: 700; letter-spacing: -0.035em; color: ${C.text};">${escapeHtml(text)}</h1>`
}

/** The headline moment: how many things wait, big in the waiting colour, with its label beside it. */
export function bigNumber(count: number, label: string): string {
	return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 18px;"><tr><td valign="middle" class="m-wait m-big" style="padding-right: 12px; font-family: ${FONT}; font-size: 32px; line-height: 36px; font-weight: 700; letter-spacing: -0.04em; color: ${C.warning};">${count}</td><td valign="middle" class="m-text m-h1" style="font-family: ${FONT}; font-size: 22px; line-height: 28px; font-weight: 700; letter-spacing: -0.035em; color: ${C.text};">${escapeHtml(label)}</td></tr></table>`
}

export function sectionHeading(text: string): string {
	return `<p class="m-text" style="margin: 26px 0 4px; font-family: ${FONT}; font-size: 15px; line-height: 20px; font-weight: 700; letter-spacing: -0.01em; color: ${C.text};">${escapeHtml(text)}</p>`
}

/** One waiting item as its own soft box. */
export function waitingRow(text: string): string {
	return `<table role="presentation" class="m-box" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 8px; ${BOX}"><tr><td class="m-text" style="padding: 12px 14px; font-family: ${FONT}; font-size: 15px; line-height: 22px; color: ${C.text};">${escapeHtml(text)}</td></tr></table>`
}

/** Finished agent runs, one row each with a round tick, rows split by a hairline. */
export function tickList(lines: string[]): string {
	return lines
		.map(
			(l, i) =>
				`<table role="presentation" class="m-rule" width="100%" cellpadding="0" cellspacing="0" border="0" style="${i > 0 ? `border-top: 1px solid ${C.hairline};` : ''}"><tr><td width="34" valign="top" style="padding: 13px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="m-tick" align="center" width="22" height="22" style="width: 22px; height: 22px; border-radius: 11px; background-color: ${C.successFill}; color: ${C.success}; font-family: Arial, sans-serif; font-size: 12px; line-height: 22px; font-weight: 700;">${TICK}</td></tr></table></td><td class="m-text" style="padding: 12px 0; font-family: ${FONT}; font-size: 15px; line-height: 22px; color: ${C.text};">${escapeHtml(l)}</td></tr></table>`,
		)
		.join('')
}

/** The next step as one soft box. */
export function nextStepLine(text: string): string {
	return `<table role="presentation" class="m-box" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 8px; ${BOX}"><tr><td class="m-text" style="padding: 12px 14px; font-family: ${FONT}; font-size: 15px; line-height: 22px; font-weight: 600; color: ${C.text};">${escapeHtml(text)}</td></tr></table>`
}

/** Secondary text (the onboarding lesson, the Marketplace pick) in a soft box; one line per entry. */
export function softBox(text: string | string[]): string {
	const lines = (Array.isArray(text) ? text : [text]).map(escapeHtml).join('<br>')
	return `<table role="presentation" class="m-box" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 20px 0 0; ${BOX}"><tr><td class="m-muted" style="padding: 12px 14px; font-family: ${FONT}; font-size: 14px; line-height: 22px; color: ${C.muted};">${lines}</td></tr></table>`
}

/** Plain paragraph for the notification's own text. */
export function paragraph(text: string): string {
	return `<p class="m-text" style="margin: 0; padding: 0 0 16px; font-family: ${FONT}; font-size: 16px; line-height: 25px; color: ${C.text};">${escapeHtml(text)}</p>`
}

/** The one brand-coloured button. */
export function button(url: string, label: string): string {
	return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 16px 0 4px;"><tr><td class="m-btn" bgcolor="${MAIN_BUTTON.bg}" style="background-color: ${MAIN_BUTTON.bg}; border-radius: 10px;"><a class="m-btn-text" href="${escapeHtml(url)}" style="display: inline-block; padding: 12px 22px; font-family: ${FONT}; font-size: 15px; line-height: 20px; font-weight: 600; color: ${MAIN_BUTTON.text}; text-decoration: none;">${escapeHtml(label)}</a></td></tr></table>`
}

/** A quiet inline link. */
export function quietLink(url: string, label: string): string {
	return `<a class="m-link" href="${escapeHtml(url)}" style="color: ${C.muted}; text-decoration: underline;">${escapeHtml(label)}</a>`
}

/** A row of quiet links under a block, separated by a dot. */
export function linkRow(links: Array<{ url: string; label: string }>): string {
	return `<p class="m-muted" style="margin: 12px 0 0; font-family: ${FONT}; font-size: 14px; line-height: 22px; color: ${C.muted};">${links.map((l) => quietLink(l.url, l.label)).join(' &nbsp;&middot;&nbsp; ')}</p>`
}

/** Light colours of the small type label; the dark ones are in DARK_CSS. Unknown types look like a task. */
const CHIPS: Record<string, { bg: string; fg: string }> = {
	bet: { bg: '#e8edfb', fg: '#1b36a0' },
	task: { bg: '#eef0f4', fg: '#5a6372' },
	flow: { bg: '#fae8ff', fg: '#86198f' },
	chat: { bg: '#cffafe', fg: '#155e75' },
	insight: { bg: '#fef3c7', fg: '#92400e' },
}

/** A small type label ("Bet", "Chat"). `kind` picks the colour; any other kind looks like a task. */
export function chip(kind: string, label: string): string {
	const key = kind in CHIPS ? kind : 'task'
	const c = CHIPS[key] as { bg: string; fg: string }
	return `<span class="m-chip-${key}" style="display: inline-block; padding: 0 7px; border-radius: 6px; font-size: 12px; line-height: 18px; font-weight: 600; background-color: ${c.bg}; color: ${c.fg};">${escapeHtml(label)}</span>`
}

/** A section title with its count, like "Needs you 2". `quiet` is the smaller grey kind used for the groups under Updates. */
export function countHeading(label: string, count: number, quiet = false): string {
	return quiet
		? `<p class="m-muted" style="margin: 20px 0 2px; font-family: ${FONT}; font-size: 13px; line-height: 18px; font-weight: 600; color: ${C.muted};">${escapeHtml(label)} <span style="font-weight: 400;">${count}</span></p>`
		: `<p class="m-text" style="margin: 22px 0 8px; font-family: ${FONT}; font-size: 15px; line-height: 20px; font-weight: 700; letter-spacing: -0.01em; color: ${C.text};">${escapeHtml(label)} <span class="m-muted" style="font-weight: 400; color: ${C.muted};">${count}</span></p>`
}

export interface NeedRow {
	title: string
	/** One line of what is asked; null leaves it out. */
	line: string | null
	/** Type label text and colour key. */
	typeLabel: string
	typeKind: string
	/** "Asked 09:12", "Due Wed 10:00". */
	when: string
	url: string
	/** "Review" or "Reply". */
	buttonLabel: string
}

/** The Needs you box: one row per waiting item, each with its own small button. */
export function needBox(rows: NeedRow[]): string {
	const body = rows
		.map(
			(r, i) =>
				`<table role="presentation" class="m-boxrule" width="100%" cellpadding="0" cellspacing="0" border="0" style="${i > 0 ? `border-top: 1px solid ${C.border};` : ''}"><tr><td style="padding: 14px 0;"><a class="m-text" href="${escapeHtml(r.url)}" style="font-family: ${FONT}; font-size: 15px; line-height: 21px; font-weight: 600; color: ${C.text}; text-decoration: none;">${escapeHtml(r.title)}</a>${r.line ? `<br><span class="m-text" style="font-family: ${FONT}; font-size: 14px; line-height: 21px; color: ${C.text};">${escapeHtml(r.line)}</span>` : ''}<br><span class="m-muted" style="font-family: ${FONT}; font-size: 13px; line-height: 22px; color: ${C.muted};">${chip(r.typeKind, r.typeLabel)}&nbsp; ${escapeHtml(r.when)}</span></td><td width="96" align="right" valign="middle" style="padding: 14px 0 14px 12px;"><a class="m-mini" href="${escapeHtml(r.url)}" style="display: inline-block; padding: 8px 14px; border: 1px solid #c9ced6; border-radius: 8px; font-family: ${FONT}; font-size: 14px; line-height: 18px; font-weight: 600; color: ${C.text}; text-decoration: none;">${escapeHtml(r.buttonLabel)}</a></td></tr></table>`,
		)
		.join('')
	return `<table role="presentation" class="m-box" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 4px 0 6px; ${BOX}"><tr><td style="padding: 4px 18px;">${body}</td></tr></table>`
}

export interface UpdateRow {
	title: string
	/** What happened and when, like "Developer finished, 11:40". */
	line: string
	url: string
}

/** One update per row: a linked title and a quiet line. No label, no button. */
export function updateRows(rows: UpdateRow[]): string {
	return rows
		.map(
			(r, i) =>
				`<table role="presentation" class="m-rule" width="100%" cellpadding="0" cellspacing="0" border="0" style="${i > 0 ? `border-top: 1px solid ${C.hairline};` : ''}"><tr><td class="m-text" style="padding: 9px 0; font-family: ${FONT}; font-size: 14px; line-height: 20px; color: ${C.text};"><a class="m-text" href="${escapeHtml(r.url)}" style="color: ${C.text}; text-decoration: none; font-weight: 600;">${escapeHtml(r.title)}</a> <span class="m-muted" style="color: ${C.muted};">&nbsp;${escapeHtml(r.line)}</span></td></tr></table>`,
		)
		.join('')
}

/** The "N more in Maskin" link under a list. */
export function moreLink(url: string, label: string): string {
	return `<p style="margin: 6px 0 0; font-family: ${FONT}; font-size: 14px; line-height: 20px;">${quietLink(url, label)}</p>`
}

/** Plain space between the last list and the button. */
export function spacer(px = 18): string {
	return `<div style="height: ${px}px; line-height: ${px}px; font-size: ${px}px;">&nbsp;</div>`
}

export interface EmailLayoutInput {
	/** Hidden inbox preview line; should say something other than the subject. */
	preheader: string
	/** Block HTML from the helpers above, in reading order. */
	blocks: string[]
	/** One sentence in the footer before the stop link (the digest says when and how often it comes). */
	footerNote?: string
	/** Signed stop link for the footer. Left out for a mail about the account itself, which has no stop link. */
	stopUrl?: string
}

/**
 * Wraps the blocks in the shared page: grey background, the Maskin logo and wordmark, a white card
 * about 600 px wide with a hairline border, and a quiet footer with the stop link (none when
 * stopUrl is left out).
 */
export function renderEmail({ preheader, blocks, footerNote, stopUrl }: EmailLayoutInput): string {
	// Padding after the preheader keeps the client from pulling body text into the inbox preview.
	const hidden = `<div style="display: none; max-height: 0; overflow: hidden; mso-hide: all; font-size: 1px; line-height: 1px; color: ${C.page};">${escapeHtml(preheader)}${'&nbsp;&zwnj;'.repeat(40)}</div>`
	const header = `<tr><td class="m-pad" style="padding: 0 6px 18px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle" style="padding-right: 10px;"><a href="${HOME_URL}" style="text-decoration: none;"><img class="m-logo" src="${LOGO_URL}" width="30" height="30" alt="Maskin" border="0" style="display: block; width: 30px; height: 30px; border: 0; border-radius: 7px;"></a></td><td valign="middle" style="font-family: ${FONT}; font-size: 19px; line-height: 24px; font-weight: 700; letter-spacing: -0.02em;"><a class="m-text" href="${HOME_URL}" style="color: ${C.text}; text-decoration: none;">Maskin</a></td></tr></table></td></tr>`
	const footer = `<tr><td class="m-pad m-muted" style="padding: 22px 6px 0; font-family: ${FONT}; font-size: 13px; line-height: 20px; color: ${C.muted};">${footerNote ? `${escapeHtml(footerNote)} ` : ''}${stopUrl ? `${quietLink(stopUrl, 'Stop these emails')}<br>` : footerNote ? '<br>' : ''}<a class="m-link" href="${HOME_URL}" style="color: ${C.muted}; text-decoration: underline;">maskin.io</a></td></tr>`
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
		`<tr><td class="m-card" bgcolor="${C.card}" style="background-color: ${C.card}; border: 1px solid ${C.border}; border-radius: 14px;">`,
		'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">',
		`<tr><td class="m-pad" style="padding: 34px 36px 38px;">${blocks.join('')}</td></tr>`,
		'</table>',
		'</td></tr>',
		footer,
		'</table>',
		'</td></tr></table>',
		'</body>',
		'</html>',
	].join('\n')
}
