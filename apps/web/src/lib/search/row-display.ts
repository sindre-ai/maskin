// How a search row reads on screen. The endpoint sends the raw title and sub line;
// both surfaces (the page and the launcher) pass them through here so a blank title
// and a trigger type read the same everywhere.

import type { SearchResultRow } from '@maskin/shared'

// An automation's sub line is its trigger type. People know these as how it starts.
const TRIGGER_TYPE_WORDS: Record<string, string> = {
	cron: 'Schedule',
	event: 'Event',
	reminder: 'Reminder',
}

/** An object can have no title; its row still needs something to click. */
export function rowTitle(row: Pick<SearchResultRow, 'title'>): string {
	return row.title.trim() === '' ? 'Untitled' : row.title
}

/** The muted text after the title, or undefined when there is none. */
export function rowSub(row: Pick<SearchResultRow, 'group' | 'sub'>): string | undefined {
	if (!row.sub) return undefined
	if (row.group === 'automations') return TRIGGER_TYPE_WORDS[row.sub] ?? row.sub
	return row.sub
}
