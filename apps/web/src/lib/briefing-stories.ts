/**
 * The For you briefing cards (the web twin of the iOS story row). A card is one
 * HTML file marked `kind: "briefing"` — the Chief of Staff's daily page or a
 * loop's briefing. Pure helpers only, so the rules are tested without a server.
 */

export const MAX_BRIEFING_CARDS = 12

const SEEN_KEY = 'maskin-seen-briefings'
const SEEN_LIMIT = 200

function collapse(text: string | null | undefined): string {
	return (text ?? '').split(/\s+/).filter(Boolean).join(' ')
}

/** `Briefing 2026-10-21.html` → `Briefing 2026 10 21`. Separators read as spaces. */
function headlineFromFileName(name: string): string {
	const dot = name.lastIndexOf('.')
	const base = dot > 0 ? name.slice(0, dot) : name
	const spaced = base.replace(/[_-]+/g, ' ').trim()
	return spaced || name
}

/**
 * The page's own title: `<title>`, else the first `<h1>`, else the file name
 * without its extension. Parsed with DOMParser, which builds an inert document
 * (no scripts run, nothing loads), and decodes entities for us.
 */
export function briefingHeadline(html: string | null | undefined, fileName: string): string {
	if (html) {
		const doc = new DOMParser().parseFromString(html, 'text/html')
		const title = collapse(doc.title)
		if (title) return title
		const heading = collapse(doc.querySelector('h1')?.textContent)
		if (heading) return heading
	}
	return headlineFromFileName(fileName)
}

export interface BriefingFile {
	id: string
	name: string
	mimeType: string
	updatedAt: string
}

/** The HTML briefings, newest first, capped — anything that can't be shown as a page is dropped. */
export function pickBriefingPages<T extends BriefingFile>(files: T[]): T[] {
	const seen = new Set<string>()
	return files
		.filter((file) => file.mimeType === 'text/html' && !seen.has(file.id) && seen.add(file.id))
		.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
		.slice(0, MAX_BRIEFING_CARDS)
}

/** "1 MIN READ" needs a length the page doesn't carry, so a page is just labelled a briefing. */
export const BRIEFING_FORMAT_LABEL = 'Briefing'

// -- seen state ---------------------------------------------------------------
// A page edited after it was opened is unseen again, so the stamp carries the
// time it was last updated.

function stamp(card: { id: string; updatedAt: string }): string {
	return `${card.id}@${Math.floor(Date.parse(card.updatedAt) / 1000) || '-'}`
}

function readSeen(): string[] {
	try {
		const raw = localStorage.getItem(SEEN_KEY)
		const parsed: unknown = raw ? JSON.parse(raw) : []
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
	} catch {
		// Privacy-mode / corrupt storage: treat everything as unseen rather than crash the feed.
		return []
	}
}

export function seenBriefingStamps(): Set<string> {
	return new Set(readSeen())
}

export function isBriefingSeen(
	card: { id: string; updatedAt: string },
	seen: Set<string> = seenBriefingStamps(),
): boolean {
	return seen.has(stamp(card))
}

export function markBriefingSeen(card: { id: string; updatedAt: string }): void {
	try {
		const all = readSeen()
		const value = stamp(card)
		if (all.includes(value)) return
		localStorage.setItem(SEEN_KEY, JSON.stringify([...all, value].slice(-SEEN_LIMIT)))
	} catch {
		// Best-effort: a full or blocked storage must never break reading a briefing.
	}
}

/** The row's order: unseen cards first, seen ones after, each keeping its own (newest-first) order. */
export function orderBriefingRow<T extends { id: string; updatedAt: string }>(
	cards: T[],
	seen: Set<string>,
): T[] {
	return [
		...cards.filter((card) => !isBriefingSeen(card, seen)),
		...cards.filter((card) => isBriefingSeen(card, seen)),
	]
}
