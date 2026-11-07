/**
 * "Later" on a For you decision card: a reminder that lives in this browser only
 * (v16 prototype: "Later · back tomorrow, 08:00 · only you are reminded, this
 * browser only"). Nothing is sent to the server, so another device or another
 * person still sees the card; the card simply steps out of Decisions here until
 * the chosen time, or until the reader brings it back.
 *
 * Everything that can be decided without React lives here as pure functions;
 * only `readLaterStore` / `writeLaterStore` touch localStorage.
 */

/** Versioned: a future shape change bumps the number and the old key is ignored. */
export const LATER_STORAGE_KEY = 'maskin:foryou-later:v1'
/** A hard bound so a long-lived browser cannot grow the key without limit. */
export const LATER_MAX_ENTRIES = 200

export interface LaterEntry {
	/** Epoch ms at which the card comes back. */
	until: number
	/** What the reader picked, in words ("Tomorrow, 08:00"). */
	label: string
	/** The newest event on the thread when it was set aside; a later one brings it back. */
	eventId: number
}

/** Storage key (`<workspaceId>|<cardKey>`) to entry, for every workspace in this browser. */
export type LaterStore = Record<string, LaterEntry>

export function laterKey(workspaceId: string, cardKey: string): string {
	return `${workspaceId}|${cardKey}`
}

function isEntry(value: unknown): value is LaterEntry {
	if (!value || typeof value !== 'object') return false
	const entry = value as Record<string, unknown>
	return (
		typeof entry.until === 'number' &&
		Number.isFinite(entry.until) &&
		typeof entry.label === 'string' &&
		typeof entry.eventId === 'number' &&
		Number.isFinite(entry.eventId)
	)
}

/** Drops what is due and keeps the `LATER_MAX_ENTRIES` that come back last. */
export function pruneLaterStore(store: LaterStore, now: number): LaterStore {
	const live = Object.entries(store).filter(([, entry]) => entry.until > now)
	if (live.length > LATER_MAX_ENTRIES) {
		live.sort((a, b) => b[1].until - a[1].until)
		live.length = LATER_MAX_ENTRIES
	}
	return Object.fromEntries(live)
}

/** Reads storage text defensively: anything unexpected is an empty store, never a throw. */
export function parseLaterStore(raw: string | null, now: number): LaterStore {
	if (!raw) return {}
	try {
		const parsed: unknown = JSON.parse(raw)
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
		const store: LaterStore = {}
		for (const [key, value] of Object.entries(parsed)) {
			if (isEntry(value)) store[key] = value
		}
		return pruneLaterStore(store, now)
	} catch {
		return {}
	}
}

export function addLater(
	store: LaterStore,
	key: string,
	entry: LaterEntry,
	now: number,
): LaterStore {
	return pruneLaterStore({ ...store, [key]: entry }, now)
}

export function removeLater(store: LaterStore, key: string): LaterStore {
	if (!(key in store)) return store
	const { [key]: _removed, ...rest } = store
	return rest
}

/** The entries of one workspace, keyed by card. */
export function laterForWorkspace(
	store: LaterStore,
	workspaceId: string,
): Record<string, LaterEntry> {
	const prefix = `${workspaceId}|`
	const out: Record<string, LaterEntry> = {}
	for (const [key, entry] of Object.entries(store)) {
		if (key.startsWith(prefix)) out[key.slice(prefix.length)] = entry
	}
	return out
}

/**
 * Whether a card is set aside right now. A stale entry (the card is gone, or it is due) is
 * simply not "set aside", so it never hides anything; a newer event on the thread means
 * there is something new to answer, so that brings it back too.
 */
export function isSetAside(
	entry: LaterEntry | undefined,
	latestEventId: number | null | undefined,
	now: number,
): boolean {
	if (!entry || entry.until <= now) return false
	return (latestEventId ?? 0) <= entry.eventId
}

/** The soonest time any entry comes back, to schedule the re-render. */
export function nextLaterDue(store: LaterStore, now: number): number | null {
	let next: number | null = null
	for (const entry of Object.values(store)) {
		if (entry.until > now && (next === null || entry.until < next)) next = entry.until
	}
	return next
}

export interface LaterOption {
	label: string
	until: number
}

const REMIND_HOUR = 8
const EVENING_HOUR = 18

function atHour(base: Date, dayOffset: number, hour: number): Date {
	const date = new Date(base)
	date.setDate(date.getDate() + dayOffset)
	date.setHours(hour, 0, 0, 0)
	return date
}

/** The four quick choices the prototype offers. "This evening" drops out once it is past. */
export function laterOptions(now: Date): LaterOption[] {
	const options: LaterOption[] = []
	const evening = atHour(now, 0, EVENING_HOUR)
	if (evening.getTime() > now.getTime()) {
		options.push({ label: 'This evening, 18:00', until: evening.getTime() })
	}
	options.push({ label: 'Tomorrow, 08:00', until: atHour(now, 1, REMIND_HOUR).getTime() })
	// Days until the next Monday, never today.
	const toMonday = (8 - now.getDay()) % 7 || 7
	if (toMonday > 1) {
		options.push({ label: 'Monday, 08:00', until: atHour(now, toMonday, REMIND_HOUR).getTime() })
	}
	options.push({
		label: 'Next week, Monday 08:00',
		until: atHour(now, toMonday + 7, REMIND_HOUR).getTime(),
	})
	return options
}

/** A picked calendar day (`YYYY-MM-DD`) at 08:00; null for junk or a day that is not after today. */
export function laterOptionFromDate(value: string, now: Date): LaterOption | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
	if (!match) return null
	const date = new Date(
		Number(match[1]),
		Number(match[2]) - 1,
		Number(match[3]),
		REMIND_HOUR,
		0,
		0,
		0,
	)
	if (Number.isNaN(date.getTime()) || date.getTime() <= now.getTime()) return null
	const day = date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
	return { label: `${day}, 08:00`, until: date.getTime() }
}

/** The earliest day the date field accepts (tomorrow), as `YYYY-MM-DD`. */
export function laterMinDate(now: Date): string {
	const date = atHour(now, 1, 0)
	const pad = (n: number) => String(n).padStart(2, '0')
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The toast sentence: "Back tomorrow, 08:00. Only you are reminded." */
export function laterToast(label: string): string {
	return `Back ${label.charAt(0).toLowerCase()}${label.slice(1)}. Only you are reminded.`
}

export function readLaterStore(now: number = Date.now()): LaterStore {
	try {
		return parseLaterStore(localStorage.getItem(LATER_STORAGE_KEY), now)
	} catch {
		// Privacy mode: Later then lasts for this visit only, which is still honest.
		return {}
	}
}

export function writeLaterStore(store: LaterStore): void {
	try {
		localStorage.setItem(LATER_STORAGE_KEY, JSON.stringify(store))
	} catch {
		// Best effort: a full or blocked storage must never break the feed.
	}
}
