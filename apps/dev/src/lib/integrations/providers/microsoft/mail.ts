import { parseRecipients } from '../gmail/send'
import type { Built } from './calendar'
import { GRAPH_BASE } from './graph'

/**
 * Outlook mail for the Microsoft MCP tools (./mcp-server.ts). Pure: builds the Graph addresses and
 * bodies, validates what an agent passed, and trims messages to the fields an agent needs. No I/O
 * here, so every rule is unit-tested without a server.
 *
 * Reads and one write: a draft in the person's Drafts folder. Nothing here sends. Graph's send
 * address needs Mail.Send, which the sign-in does not hold, and no builder below produces it.
 */

export const MAIL_DEFAULT_LIMIT = 25
export const MAIL_MAX_LIMIT = 50

const MAX_ID_LENGTH = 1_000
const MAX_QUERY_LENGTH = 200
const MAX_PREVIEW_CHARS = 500
const MAX_BODY_CHARS = 8_000
const MAX_RECIPIENTS = 20
const MAX_SUBJECT_LENGTH = 998
const MAX_DRAFT_BODY_LENGTH = 100_000

export const MAIL_FOLDERS = ['inbox', 'sentitems', 'drafts', 'archive', 'deleteditems'] as const
export type MailFolder = (typeof MAIL_FOLDERS)[number]

const SUMMARY_SELECT = [
	'id',
	'subject',
	'from',
	'toRecipients',
	'ccRecipients',
	'receivedDateTime',
	'sentDateTime',
	'isRead',
	'isDraft',
	'hasAttachments',
	'importance',
	'conversationId',
	'webLink',
	'bodyPreview',
].join(',')

/** Graph answers with the body as plain text when it is sent this. */
export const MAIL_TEXT_HEADERS = { Prefer: 'outlook.body-content-type="text"' }

function clampLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return MAIL_DEFAULT_LIMIT
	return Math.min(MAIL_MAX_LIMIT, Math.max(1, Math.trunc(limit)))
}

/**
 * Newest first in one folder. `$orderby` on receivedDateTime together with a filter on another
 * property is refused by Graph (InefficientFilter) unless receivedDateTime is filtered first, so
 * the filter always starts with it, from `since` or from the epoch.
 */
export function buildListMessagesRequest(input: {
	folder?: MailFolder
	unread_only?: boolean
	since?: string
	limit?: number
}): Built<{ url: string; limit: number; folder: MailFolder }> {
	const folder = input.folder ?? 'inbox'
	let since = '1970-01-01T00:00:00Z'
	if (input.since !== undefined) {
		const when = new Date(input.since)
		if (Number.isNaN(when.getTime())) {
			return {
				ok: false,
				message: 'since must be a date such as 2026-11-13 or 2026-11-13T09:00:00+01:00.',
			}
		}
		since = when.toISOString()
	}
	const filter = [`receivedDateTime ge ${since}`, ...(input.unread_only ? ['isRead eq false'] : [])]
	const limit = clampLimit(input.limit)
	const params = [
		`$top=${limit + 1}`,
		`$orderby=${encodeURIComponent('receivedDateTime desc')}`,
		`$filter=${encodeURIComponent(filter.join(' and '))}`,
		`$select=${SUMMARY_SELECT}`,
	]
	return {
		ok: true,
		url: `${GRAPH_BASE}/me/mailFolders/${folder}/messages?${params.join('&')}`,
		limit,
		folder,
	}
}

/**
 * Graph's own mailbox search over the whole mailbox (subject, body, people). It cannot be
 * combined with $orderby or $filter and takes no $skip, so one page is all there is. Double
 * quotes are dropped from the text because they would end the quoted search string early.
 */
export function buildSearchMessagesRequest(input: {
	query: string
	limit?: number
}): Built<{ url: string; limit: number }> {
	const query = input.query.replace(/"/g, ' ').replace(/\s+/g, ' ').trim()
	if (query === '') return { ok: false, message: 'query must not be empty.' }
	if (query.length > MAX_QUERY_LENGTH) {
		return { ok: false, message: `query can be at most ${MAX_QUERY_LENGTH} characters.` }
	}
	const limit = clampLimit(input.limit)
	const params = [
		`$search=${encodeURIComponent(`"${query}"`)}`,
		`$top=${limit + 1}`,
		`$select=${SUMMARY_SELECT}`,
	]
	return { ok: true, url: `${GRAPH_BASE}/me/messages?${params.join('&')}`, limit }
}

export function buildGetMessageRequest(id: string): Built<{ url: string }> {
	const trimmed = id.trim()
	if (trimmed === '' || trimmed.length > MAX_ID_LENGTH) {
		return {
			ok: false,
			message: 'id must be a message id from outlook_list_messages or outlook_search_messages.',
		}
	}
	// Message ids hold characters that mean something in an address (=, +, /), so encode them whole.
	return {
		ok: true,
		url: `${GRAPH_BASE}/me/messages/${encodeURIComponent(trimmed)}?$select=${SUMMARY_SELECT},body`,
	}
}

export interface DraftInput {
	to: string
	cc?: string
	subject: string
	body: string
}

function recipientsOrMessage(value: string, label: string) {
	try {
		return parseRecipients(value, label)
	} catch (err) {
		return err instanceof Error ? err.message : `The "${label}" field is not valid.`
	}
}

/** The Graph message for a new draft. Plain text body; Graph keeps it in Drafts and sends nothing. */
export function buildDraftRequest(input: DraftInput): Built<{ url: string; body: unknown }> {
	if (/[\r\n]/.test(input.subject)) {
		return { ok: false, message: 'The subject must be one line.' }
	}
	const subject = input.subject.trim()
	if (subject === '' || subject.length > MAX_SUBJECT_LENGTH) {
		return { ok: false, message: `subject must be 1 to ${MAX_SUBJECT_LENGTH} characters.` }
	}
	if (input.body.trim() === '' || input.body.length > MAX_DRAFT_BODY_LENGTH) {
		return { ok: false, message: `body must be 1 to ${MAX_DRAFT_BODY_LENGTH} characters.` }
	}
	const to = recipientsOrMessage(input.to, 'to')
	if (typeof to === 'string') return { ok: false, message: to }
	const cc = input.cc?.trim() ? recipientsOrMessage(input.cc, 'cc') : []
	if (typeof cc === 'string') return { ok: false, message: cc }
	if (to.length + cc.length > MAX_RECIPIENTS) {
		return { ok: false, message: `At most ${MAX_RECIPIENTS} recipients are allowed.` }
	}
	const toGraph = (r: { address: string; name: string | null }) => ({
		emailAddress: { address: r.address, ...(r.name ? { name: r.name } : {}) },
	})
	return {
		ok: true,
		url: `${GRAPH_BASE}/me/messages`,
		body: {
			subject,
			body: { contentType: 'text', content: input.body },
			toRecipients: to.map(toGraph),
			ccRecipients: cc.map(toGraph),
		},
	}
}

// ── Trimming ─────────────────────────────────────────────────────────────

interface GraphRecipient {
	emailAddress?: { name?: string; address?: string }
}

export interface GraphMessage {
	id?: string
	subject?: string | null
	from?: GraphRecipient
	toRecipients?: GraphRecipient[]
	ccRecipients?: GraphRecipient[]
	receivedDateTime?: string
	sentDateTime?: string
	isRead?: boolean
	isDraft?: boolean
	hasAttachments?: boolean
	importance?: string
	conversationId?: string
	webLink?: string
	bodyPreview?: string
	body?: { content?: string }
}

function person(r: GraphRecipient | undefined) {
	return { name: r?.emailAddress?.name || null, email: r?.emailAddress?.address || null }
}

function cut(text: string | undefined, max: number): string {
	const value = (text ?? '').trim()
	return value.length > max ? `${value.slice(0, max)}...` : value
}

export interface TrimmedMessage {
	id: string | null
	subject: string
	from: { name: string | null; email: string | null }
	to: Array<{ name: string | null; email: string | null }>
	cc: Array<{ name: string | null; email: string | null }>
	received_at: string | null
	sent_at: string | null
	is_read: boolean
	is_draft: boolean
	has_attachments: boolean
	importance: string | null
	conversation_id: string | null
	web_link: string | null
	preview: string
	body?: string
}

/** The fields an agent needs. `withBody` is for a single message opened by id. */
export function trimMessage(raw: GraphMessage, withBody = false): TrimmedMessage {
	const out: TrimmedMessage = {
		id: raw.id ?? null,
		subject: raw.subject ?? '',
		from: person(raw.from),
		to: (raw.toRecipients ?? []).slice(0, MAX_RECIPIENTS).map(person),
		cc: (raw.ccRecipients ?? []).slice(0, MAX_RECIPIENTS).map(person),
		received_at: raw.receivedDateTime ?? null,
		sent_at: raw.sentDateTime ?? null,
		is_read: raw.isRead === true,
		is_draft: raw.isDraft === true,
		has_attachments: raw.hasAttachments === true,
		importance: raw.importance ?? null,
		conversation_id: raw.conversationId ?? null,
		web_link: raw.webLink ?? null,
		preview: cut(raw.bodyPreview, MAX_PREVIEW_CHARS),
	}
	if (withBody) out.body = cut(raw.body?.content, MAX_BODY_CHARS)
	return out
}
