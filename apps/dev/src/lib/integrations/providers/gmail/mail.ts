/**
 * Reading and tidying Gmail through Gmail's normal API (`gmail.googleapis.com`), the same one
 * that send and save-attachment use. Google's hosted Gmail tool server can refuse our sign-in
 * with a 401 while this API still accepts the same token, so these calls keep agents reading
 * mail when the hosted tools are down. The hosted tools are not replaced.
 *
 * Narrow on purpose: search threads, read one thread, change the labels of one thread (archive
 * is removing INBOX). Nothing here sends, drafts, trashes or deletes. The read scopes
 * (`gmail.readonly`, `gmail.modify`) are already in the connect scopes, so no install has to
 * reconnect. Ids and label names are checked before they reach a URL or a request body.
 */

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

const MAX_PART_DEPTH = 20
/** Text kept per message body, so one long newsletter cannot fill an agent's context. */
export const GMAIL_BODY_MAX_CHARS = 20_000
export const GMAIL_SEARCH_MAX_RESULTS = 20
const MAX_QUERY_LENGTH = 500
const MAX_LABELS_PER_CALL = 20

// Gmail thread and message ids are hex; page tokens are short opaque strings. Anything else is
// refused before it reaches a URL, so a value cannot add a path segment or a query.
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const PAGE_TOKEN_RE = /^[A-Za-z0-9_.-]{1,512}$/

/** A label name or id: 1 to 225 characters, no control characters. */
const isLabelName = (value: string): boolean => {
	if (value.length < 1 || value.length > 225) return false
	for (const ch of value) {
		const code = ch.charCodeAt(0)
		if (code < 0x20 || code === 0x7f) return false
	}
	return true
}

/** Labels this module will not add or remove: they would send, trash or delete, not tidy. */
const LOCKED_LABEL_IDS = new Set(['TRASH', 'SPAM', 'DRAFT', 'SENT', 'CHAT'])

export type GmailMailErrorCode =
	| 'INVALID_INPUT'
	| 'NOT_FOUND'
	| 'INSUFFICIENT_SCOPE'
	| 'RECONSENT_REQUIRED'
	| 'REJECTED'
	| 'UNAVAILABLE'

export class GmailMailError extends Error {
	constructor(
		readonly code: GmailMailErrorCode,
		message: string,
	) {
		super(message)
		this.name = 'GmailMailError'
	}
}

async function gmailCall<T>(
	accessToken: string,
	method: 'GET' | 'POST',
	path: string,
	body?: unknown,
): Promise<T> {
	let res: Response
	try {
		res = await fetch(`${GMAIL_API_BASE}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		})
	} catch {
		throw new GmailMailError('UNAVAILABLE', 'The connection to Gmail failed. Try again.')
	}
	if (res.ok) return (await res.json()) as T

	let detail = res.statusText
	try {
		detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? detail
	} catch {
		// keep the status text
	}
	if (res.status === 401) {
		throw new GmailMailError(
			'RECONSENT_REQUIRED',
			'Gmail rejected the saved login. A person needs to reconnect Gmail in Settings → Integrations.',
		)
	}
	if (res.status === 403 && /scope|insufficient/i.test(detail)) {
		throw new GmailMailError(
			'INSUFFICIENT_SCOPE',
			'This Gmail connection is not allowed to do that. A person needs to reconnect Gmail in Settings → Integrations.',
		)
	}
	if (res.status === 404) {
		throw new GmailMailError(
			'NOT_FOUND',
			'Gmail has no such thread in the connected account. Search again and use the thread_id it gives.',
		)
	}
	if (res.status >= 400 && res.status < 500) {
		throw new GmailMailError('REJECTED', `Gmail refused the request: ${detail}`)
	}
	throw new GmailMailError('UNAVAILABLE', `Gmail returned an error (${res.status}). Try again.`)
}

const assertId = (value: string, what: string) => {
	if (!ID_RE.test(value)) throw new GmailMailError('INVALID_INPUT', `That is not a Gmail ${what}.`)
}

// ---- labels -------------------------------------------------------------------------------

interface GmailLabel {
	id: string
	name: string
	type?: string
}

async function listLabels(accessToken: string): Promise<GmailLabel[]> {
	const data = await gmailCall<{ labels?: GmailLabel[] }>(
		accessToken,
		'GET',
		'/labels?fields=labels(id,name,type)',
	)
	return data.labels ?? []
}

/** System labels read better in lower case words; user labels keep the name the person gave. */
const SYSTEM_LABEL_NAMES: Record<string, string> = {
	INBOX: 'Inbox',
	UNREAD: 'Unread',
	STARRED: 'Starred',
	IMPORTANT: 'Important',
	SENT: 'Sent',
	DRAFT: 'Draft',
	SPAM: 'Spam',
	TRASH: 'Trash',
}

function labelNamer(labels: GmailLabel[]) {
	const byId = new Map(labels.map((l) => [l.id, l.name]))
	return (id: string) => SYSTEM_LABEL_NAMES[id] ?? byId.get(id) ?? id
}

// ---- reading ------------------------------------------------------------------------------

interface Header {
	name?: string
	value?: string
}

interface MessagePart {
	partId?: string
	filename?: string
	mimeType?: string
	headers?: Header[]
	body?: { attachmentId?: string; size?: number; data?: string }
	parts?: MessagePart[]
}

interface GmailMessage {
	id?: string
	labelIds?: string[]
	snippet?: string
	internalDate?: string
	payload?: MessagePart
}

interface GmailThread {
	id?: string
	messages?: GmailMessage[]
}

const header = (part: MessagePart | undefined, name: string): string => {
	const wanted = name.toLowerCase()
	return part?.headers?.find((h) => h.name?.toLowerCase() === wanted)?.value ?? ''
}

const isoDate = (internalDate: string | undefined): string | null => {
	const ms = Number(internalDate)
	return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null
}

function decodeBase64Url(data: string | undefined): string {
	return data ? Buffer.from(data, 'base64url').toString('utf8') : ''
}

function htmlToText(html: string): string {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, ' ')
		.replace(/\n\s*\n+/g, '\n\n')
		.trim()
}

interface Walked {
	plain: string[]
	html: string[]
	attachments: GmailThreadAttachment[]
}

export interface GmailThreadAttachment {
	name: string
	mime_type: string
	size_bytes: number
	part_id: string | null
	attachment_id: string
}

function walkParts(part: MessagePart, out: Walked, depth = 0) {
	if (part.body?.attachmentId && part.filename) {
		out.attachments.push({
			name: part.filename,
			mime_type: part.mimeType ?? 'application/octet-stream',
			size_bytes: part.body.size ?? 0,
			part_id: part.partId ?? null,
			attachment_id: part.body.attachmentId,
		})
	} else if (part.body?.data && !part.filename) {
		if (part.mimeType === 'text/plain') out.plain.push(decodeBase64Url(part.body.data))
		else if (part.mimeType === 'text/html') out.html.push(decodeBase64Url(part.body.data))
	}
	if (depth >= MAX_PART_DEPTH) return
	for (const child of part.parts ?? []) walkParts(child, out, depth + 1)
}

export interface GmailThreadMessage {
	message_id: string
	from: string
	to: string
	cc: string
	subject: string
	date: string | null
	labels: string[]
	body: string
	body_truncated: boolean
	attachments: GmailThreadAttachment[]
}

function toMessage(message: GmailMessage, nameOf: (id: string) => string): GmailThreadMessage {
	const walked: Walked = { plain: [], html: [], attachments: [] }
	if (message.payload) walkParts(message.payload, walked)
	// A mail with a text part is read from it; HTML only when there is nothing else.
	const text =
		walked.plain.join('\n').trim() || walked.html.map(htmlToText).join('\n\n').trim() || ''
	const truncated = text.length > GMAIL_BODY_MAX_CHARS
	return {
		message_id: message.id ?? '',
		from: header(message.payload, 'From'),
		to: header(message.payload, 'To'),
		cc: header(message.payload, 'Cc'),
		subject: header(message.payload, 'Subject'),
		date: isoDate(message.internalDate),
		labels: (message.labelIds ?? []).map(nameOf),
		body: truncated ? text.slice(0, GMAIL_BODY_MAX_CHARS) : text,
		body_truncated: truncated,
		attachments: walked.attachments,
	}
}

export interface GmailThreadDetail {
	thread_id: string
	subject: string
	labels: string[]
	messages: GmailThreadMessage[]
}

/** One thread with every message's sender, text and attachments, and the labels it carries. */
export async function readThread(
	accessToken: string,
	threadId: string,
): Promise<GmailThreadDetail> {
	assertId(threadId, 'thread id')
	const [thread, labels] = await Promise.all([
		gmailCall<GmailThread>(accessToken, 'GET', `/threads/${threadId}?format=full`),
		listLabels(accessToken),
	])
	const nameOf = labelNamer(labels)
	const messages = (thread.messages ?? []).map((m) => toMessage(m, nameOf))
	const labelNames = [...new Set(messages.flatMap((m) => m.labels))]
	return {
		thread_id: thread.id ?? threadId,
		subject: messages[0]?.subject ?? '',
		labels: labelNames,
		messages,
	}
}

export interface GmailThreadSummary {
	thread_id: string
	subject: string
	from: string
	date: string | null
	snippet: string
	message_count: number
	labels: string[]
	unread: boolean
}

export interface GmailSearchResult {
	threads: GmailThreadSummary[]
	next_page_token: string | null
}

/** Threads matching a Gmail search ("from:x is:unread newer_than:7d"), newest first. */
export async function searchThreads(
	accessToken: string,
	input: { query?: string; maxResults?: number; pageToken?: string },
): Promise<GmailSearchResult> {
	const query = (input.query ?? '').trim()
	if (query.length > MAX_QUERY_LENGTH) {
		throw new GmailMailError(
			'INVALID_INPUT',
			`The search is over ${MAX_QUERY_LENGTH} characters. Make it shorter.`,
		)
	}
	if (input.pageToken !== undefined && !PAGE_TOKEN_RE.test(input.pageToken)) {
		throw new GmailMailError('INVALID_INPUT', 'That is not a Gmail page token.')
	}
	const max = Math.min(Math.max(Math.trunc(input.maxResults ?? 10), 1), GMAIL_SEARCH_MAX_RESULTS)
	const params = new URLSearchParams({
		maxResults: String(max),
		fields: 'threads(id),nextPageToken',
	})
	if (query) params.set('q', query)
	if (input.pageToken) params.set('pageToken', input.pageToken)

	const [list, labels] = await Promise.all([
		gmailCall<{ threads?: Array<{ id?: string }>; nextPageToken?: string }>(
			accessToken,
			'GET',
			`/threads?${params}`,
		),
		listLabels(accessToken),
	])
	const nameOf = labelNamer(labels)
	const ids = (list.threads ?? []).map((t) => t.id).filter((id): id is string => !!id)
	const metadata = new URLSearchParams({ format: 'metadata' })
	for (const h of ['From', 'Subject']) metadata.append('metadataHeaders', h)
	metadata.set('fields', 'id,messages(id,labelIds,snippet,internalDate,payload/headers)')

	const threads = await Promise.all(
		ids.map(async (id): Promise<GmailThreadSummary> => {
			assertId(id, 'thread id')
			const thread = await gmailCall<GmailThread>(accessToken, 'GET', `/threads/${id}?${metadata}`)
			const messages = thread.messages ?? []
			const first = messages[0]
			const last = messages[messages.length - 1]
			const labelIds = [...new Set(messages.flatMap((m) => m.labelIds ?? []))]
			return {
				thread_id: id,
				subject: header(first?.payload, 'Subject'),
				from: header(first?.payload, 'From'),
				date: isoDate(last?.internalDate),
				snippet: last?.snippet ?? '',
				message_count: messages.length,
				labels: labelIds.map(nameOf),
				unread: labelIds.includes('UNREAD'),
			}
		}),
	)
	return { threads, next_page_token: list.nextPageToken ?? null }
}

// ---- changing labels ----------------------------------------------------------------------

export interface GmailLabelChange {
	archive?: boolean
	addLabels?: string[]
	removeLabels?: string[]
}

export interface GmailLabelChangeResult {
	thread_id: string
	archived: boolean
	added: string[]
	removed: string[]
	labels: string[]
}

/**
 * Archive a thread (take it out of the inbox) and add or remove labels, in one call. A label is
 * named by its Gmail name ("Receipts", "Inbox") or id. A label that does not exist is refused
 * rather than created, and labels that would trash, spam, send or delete are refused.
 */
export async function changeThreadLabels(
	accessToken: string,
	threadId: string,
	change: GmailLabelChange,
): Promise<GmailLabelChangeResult> {
	assertId(threadId, 'thread id')
	const addNames = change.addLabels ?? []
	const removeNames = [...(change.removeLabels ?? []), ...(change.archive ? ['INBOX'] : [])]
	if (addNames.length === 0 && removeNames.length === 0) {
		throw new GmailMailError(
			'INVALID_INPUT',
			'Nothing to change. Pass archive, add_labels or remove_labels.',
		)
	}
	if (addNames.length > MAX_LABELS_PER_CALL || removeNames.length > MAX_LABELS_PER_CALL) {
		throw new GmailMailError('INVALID_INPUT', `At most ${MAX_LABELS_PER_CALL} labels per call.`)
	}
	for (const name of [...addNames, ...removeNames]) {
		if (!isLabelName(name)) throw new GmailMailError('INVALID_INPUT', 'That is not a label.')
	}

	const labels = await listLabels(accessToken)
	const resolve = (wanted: string): GmailLabel => {
		const key = wanted.trim().toLowerCase()
		const hit =
			labels.find((l) => l.id.toLowerCase() === key) ??
			labels.find((l) => l.name.toLowerCase() === key)
		if (!hit) {
			const own = labels.filter((l) => l.type === 'user').map((l) => l.name)
			throw new GmailMailError(
				'INVALID_INPUT',
				`Gmail has no label "${wanted}". Nothing was changed. ${
					own.length > 0 ? `Your labels: ${own.join(', ')}.` : 'There are no custom labels yet.'
				}`,
			)
		}
		if (LOCKED_LABEL_IDS.has(hit.id)) {
			throw new GmailMailError(
				'INVALID_INPUT',
				`The label "${hit.name}" cannot be changed here. Nothing was changed.`,
			)
		}
		return hit
	}
	const add = [...new Set(addNames.map(resolve))]
	const remove = [...new Set(removeNames.map(resolve))]
	const both = add.find((a) => remove.some((r) => r.id === a.id))
	if (both) {
		throw new GmailMailError(
			'INVALID_INPUT',
			`The label "${both.name}" is both added and removed. Nothing was changed.`,
		)
	}

	const modified = await gmailCall<GmailThread>(
		accessToken,
		'POST',
		`/threads/${threadId}/modify?fields=id,messages(labelIds)`,
		{ addLabelIds: add.map((l) => l.id), removeLabelIds: remove.map((l) => l.id) },
	)
	const nameOf = labelNamer(labels)
	const current = [...new Set((modified.messages ?? []).flatMap((m) => m.labelIds ?? []))]
	return {
		thread_id: modified.id ?? threadId,
		archived: !current.includes('INBOX'),
		added: add.map((l) => nameOf(l.id)),
		removed: remove.map((l) => nameOf(l.id)),
		labels: current.map(nameOf),
	}
}
