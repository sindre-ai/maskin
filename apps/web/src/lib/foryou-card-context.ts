import type { UnreadItem } from '@/lib/api'
import { decisionOf } from '@/lib/foryou-card-kind'

/**
 * What a For You card says about where it belongs and by when: the event (else bet) it is for,
 * the deadline, and the writer's own "why you" sentence. Each returns null when the card does not
 * have it, so the card leaves the row out rather than printing an empty label.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "For the event: Product evening" for an event, "For: Autumn events" for anything else. */
export function cardContextLabel(item: UnreadItem): string | null {
	const context = item.context
	const title = context?.title?.trim()
	if (!context || !title) return null
	return context.type === 'event' ? `For the event: ${title}` : `For: ${title}`
}

/** The deadline as the card has it: the Chief of Staff's due date, else the writer's expiry. */
export function cardDeadline(item: UnreadItem): string | null {
	const iso = item.due_at ?? decisionOf(item)?.expires_at ?? null
	if (!iso || !Number.isFinite(new Date(iso).getTime())) return null
	return iso
}

function startOfDay(date: Date): number {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** "Wed 18 Nov", in the reader's own time zone. */
export function shortDate(iso: string): string {
	const date = new Date(iso)
	return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`
}

/**
 * "Answer by Wed 18 Nov, 2 days left", or "Answer by today". A deadline already behind us reads
 * "Was due Mon 16 Nov"; an answer card never gets there, because it leaves the feed at its expiry.
 */
export function deadlineChipText(iso: string, now: number = Date.now()): string {
	const days = Math.round((startOfDay(new Date(iso)) - startOfDay(new Date(now))) / 86_400_000)
	if (days < 0 || (days === 0 && new Date(iso).getTime() < now)) return `Was due ${shortDate(iso)}`
	if (days === 0) return 'Answer by today'
	return `Answer by ${shortDate(iso)}, ${days} ${days === 1 ? 'day' : 'days'} left`
}

/** The row's short form: "Answer by Wed 18 Nov". */
export function deadlineRowText(iso: string, now: number = Date.now()): string {
	return deadlineChipText(iso, now).split(',')[0] ?? ''
}

/** The writer's one first-person sentence on why a person has to decide. Null when they gave none. */
export function cardWhyYou(item: UnreadItem): string | null {
	const ask = decisionOf(item)?.ask?.trim()
	return ask ? ask : null
}
