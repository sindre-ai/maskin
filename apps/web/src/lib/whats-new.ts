// The sidebar's "What's new" card. Entries live in the repo (no backend); a person's
// dismissals live in this browser only. Add a new entry at the top of ENTRIES.

export interface WhatsNewEntry {
	id: string
	title: string
	body: string
	/** ISO date, YYYY-MM-DD. */
	date: string
}

export const WHATS_NEW_ENTRIES: WhatsNewEntry[] = [
	{
		id: 'filters-chats-items',
		title: 'Filters on Chats and Items',
		body: 'Narrow the lists by unread, working or by agent, and by tag.',
		date: '2026-11-05',
	},
]

export const WHATS_NEW_STORAGE_KEY = 'whats-new-dismissed'

/** Newest first; ties keep their written order. */
export function sortWhatsNew(entries: WhatsNewEntry[]): WhatsNewEntry[] {
	return entries
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => b.entry.date.localeCompare(a.entry.date) || a.index - b.index)
		.map(({ entry }) => entry)
}

/** The newest entry that has not been dismissed, or null when none is left. */
export function newestUndismissed(
	entries: WhatsNewEntry[],
	dismissed: readonly string[],
): WhatsNewEntry | null {
	const gone = new Set(dismissed)
	return sortWhatsNew(entries).find((entry) => !gone.has(entry.id)) ?? null
}

/** Reads defensively: blocked or corrupt storage means nothing is dismissed. */
export function readDismissedWhatsNew(): string[] {
	try {
		const raw = localStorage.getItem(WHATS_NEW_STORAGE_KEY)
		if (!raw) return []
		const parsed: unknown = JSON.parse(raw)
		return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
	} catch {
		return []
	}
}

export function writeDismissedWhatsNew(ids: string[]): void {
	try {
		localStorage.setItem(WHATS_NEW_STORAGE_KEY, JSON.stringify(ids))
	} catch {
		// Best effort: a full or private-mode storage must never throw.
	}
}

/** "5 Nov" for a YYYY-MM-DD date; the raw string if it does not parse. */
export function formatWhatsNewDate(date: string): string {
	const d = new Date(`${date}T00:00:00Z`)
	if (Number.isNaN(d.getTime())) return date
	return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}
