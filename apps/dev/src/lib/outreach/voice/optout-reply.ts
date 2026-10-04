import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { recordEvent } from '../../events/record-event'
import { logger } from '../../logger'
import { VOICE_OPT_OUT_ADDRESS } from './send-followup'

/**
 * Stop words that turn an opt-out reply into a rejected contact. Short and fixed
 * on purpose: this is the one place to challenge or extend the list. Matched as
 * whole words or phrases, case-insensitively, in the subject or the new text of
 * the reply (quoted text is ignored, see stripQuotedText).
 */
export const OPT_OUT_STOP_WORDS = [
	// English
	'stop',
	'unsubscribe',
	'remove me',
	'do not contact',
	// Danish
	'afmeld',
	'frameld',
	'fjern mig',
	'ikke kontakt',
] as const

export type OptOutNoopReason =
	| 'no_matching_contact'
	| 'ambiguous_match'
	| 'no_stop_word'
	| 'already_suppressed'
	| 'not_for_opt_out_address'

export type OptOutResult =
	| { changed: true; contactId: string; previousStatus: string }
	| { changed: false; reason: OptOutNoopReason }

export interface OptOutReply {
	workspaceId: string
	emailId: string
	from?: string
	to?: string[]
	subject?: string
	text?: string
	html?: string
}

// Letters and digits in any script, so Danish å, æ and ø count as word characters.
const WORD_CHAR = '\\p{L}\\p{N}'

const STOP_WORD_PATTERNS = OPT_OUT_STOP_WORDS.map(
	(word) => new RegExp(`(?<![${WORD_CHAR}])${word.replace(/ /g, '\\s+')}(?![${WORD_CHAR}])`, 'iu'),
)

// Reply clients put the original message under one of these markers. Everything
// from the first marker on is the quoted original, which for this channel
// contains our own opt-out line ("...we will stop") and must never match.
const QUOTE_MARKERS = [
	/^\s*>/,
	/^\s*-{2,}\s*(original message|oprindelig besked|videresendt besked)/i,
	/^\s*on .+ wrote:\s*$/i,
	/^\s*den .+ skrev .+:\s*$/i,
	/^\s*(from|fra):\s+\S/i,
]

export function stripQuotedText(text: string): string {
	const lines = text.split(/\r?\n/)
	const cut = lines.findIndex((line) => QUOTE_MARKERS.some((marker) => marker.test(line)))
	return (cut === -1 ? lines : lines.slice(0, cut)).join('\n')
}

const HTML_ENTITIES: Record<string, string> = {
	nbsp: ' ',
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
}

/**
 * Plain text from an HTML-only mail, for the same quoted-text stripping and stop-word
 * matching as a text part. Block-level tags become line breaks so a quote marker still
 * starts its own line, and a blockquote opens with ">" so the quoted original is cut.
 */
export function htmlToPlainText(html: string): string {
	return html
		.replace(/<(head|style|script)\b[\s\S]*?<\/\1\s*>/gi, '')
		.replace(/<blockquote\b[^>]*>/gi, '\n> ')
		.replace(/<br\b[^>]*>|<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, '\n')
		.replace(/<[^>]*>/g, '')
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
			if (name[0] !== '#') return HTML_ENTITIES[name.toLowerCase()] ?? entity
			const code =
				name.charAt(1).toLowerCase() === 'x'
					? Number.parseInt(name.slice(2), 16)
					: Number(name.slice(1))
			return Number.isInteger(code) && code > 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: entity
		})
}

/** The text part when it has content, otherwise the HTML part as plain text. */
export function replyBody(text: string | undefined, html: string | undefined): string {
	if (text?.trim()) return text
	return html ? htmlToPlainText(html) : ''
}

export function containsStopWord(subject: string | undefined, text: string | undefined): boolean {
	const haystack = [subject ?? '', stripQuotedText(text ?? '')].join('\n')
	return STOP_WORD_PATTERNS.some((pattern) => pattern.test(haystack))
}

/** "Name <a@b.dk>" or "a@b.dk" to a lower-cased bare address, or null. */
export function normalizeAddress(raw: string | undefined): string | null {
	if (!raw) return null
	const angle = raw.match(/<([^<>]+)>/)
	const address = (angle?.[1] ?? raw).trim().toLowerCase()
	return /^[^\s@]+@[^\s@]+$/.test(address) ? address : null
}

const SUPPRESSED_STATUSES: ReadonlySet<string> = new Set(['rejected', 'deleted_by_request'])

// A contact is a voice contact once the voice machinery has touched it: a voice
// status, follow_up_later (the call ended on the email request) or any voice_* or
// consent_* metadata key. A contact from another lane that happens to share an
// address is never matched, so it cannot be flipped or make the match ambiguous.
function isVoiceContact(status: string, metadata: Record<string, unknown> | null): boolean {
	if (status.startsWith('voice_') || status === 'follow_up_later') return true
	return Object.keys(metadata ?? {}).some((k) => k.startsWith('voice_') || k.startsWith('consent_'))
}

/**
 * Applies one inbound reply to the opt-out address. A stop word from a sender that
 * matches exactly one voice contact sets that contact to rejected. Every other
 * outcome changes nothing and logs voice.optout.no_change with a reason.
 *
 * The write is status-only (metadata is never read back or rewritten), under a row
 * lock, so it cannot clobber consent_* or voice_* keys written by other voice
 * code, and it serialises with applyVoiceEvent on the same contact.
 */
export async function applyOptOutReply(db: Database, reply: OptOutReply): Promise<OptOutResult> {
	const noop = (reason: OptOutNoopReason, extra: Record<string, unknown> = {}): OptOutResult => {
		logger.info('voice.optout.no_change', {
			workspaceId: reply.workspaceId,
			emailId: reply.emailId,
			reason,
			...extra,
		})
		return { changed: false, reason }
	}

	const addressedToOptOut = (reply.to ?? []).some(
		(addr) => normalizeAddress(addr) === VOICE_OPT_OUT_ADDRESS.toLowerCase(),
	)
	if (!addressedToOptOut) return noop('not_for_opt_out_address')

	if (!containsStopWord(reply.subject, replyBody(reply.text, reply.html)))
		return noop('no_stop_word')

	const sender = normalizeAddress(reply.from)
	if (!sender) return noop('no_matching_contact', { detail: 'unparseable_sender' })

	return db.transaction(async (tx) => {
		const candidates = await tx
			.select({
				id: objects.id,
				status: objects.status,
				metadata: objects.metadata,
				driver: objects.driver,
				createdBy: objects.createdBy,
			})
			.from(objects)
			.where(
				and(
					eq(objects.workspaceId, reply.workspaceId),
					eq(objects.type, 'contact'),
					sql`lower(btrim(${objects.metadata}->>'email')) = ${sender}`,
				),
			)
			.for('update')
		const matches = candidates.filter((c) =>
			isVoiceContact(c.status, (c.metadata ?? null) as Record<string, unknown> | null),
		)

		const [contact] = matches
		if (!contact) return noop('no_matching_contact')
		if (matches.length > 1) return noop('ambiguous_match', { matchCount: matches.length })

		// rejected is already the goal; deleted_by_request must not be revived as rejected.
		if (SUPPRESSED_STATUSES.has(contact.status)) {
			return noop('already_suppressed', { contactId: contact.id, status: contact.status })
		}

		await tx
			.update(objects)
			.set({ status: 'rejected', updatedAt: new Date() })
			.where(eq(objects.id, contact.id))

		await recordEvent(tx, {
			workspaceId: reply.workspaceId,
			actorId: contact.driver ?? contact.createdBy,
			action: 'status_changed',
			entityType: 'object',
			entityId: contact.id,
			data: {
				source: 'voice_optout_reply',
				email_id: reply.emailId,
				fromStatus: contact.status,
				toStatus: 'rejected',
			},
		})

		logger.info('voice.optout.rejected', {
			workspaceId: reply.workspaceId,
			emailId: reply.emailId,
			contactId: contact.id,
			previousStatus: contact.status,
		})
		return { changed: true, contactId: contact.id, previousStatus: contact.status } as const
	})
}
