import { randomUUID } from 'node:crypto'
import type { Database } from '@maskin/db'
import { files } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { sha256Hex } from '../../../file-save'
import { fileStorageKey } from '../../../file-urls'
import { logger } from '../../../logger'

/**
 * Saving one Gmail attachment as a workspace file. Google's hosted Gmail tool returns no
 * attachment bytes, so Maskin reads them itself with `users.messages.attachments.get`. The
 * read scopes (`gmail.readonly`, `gmail.modify`) are already in the connect scopes, so no
 * existing install needs to reconnect.
 *
 * Narrow on purpose: one attachment of one message of the connected account. The caller names
 * a message id, an attachment id and optionally the part id, and nothing else. The file name and
 * type come from the message part that owns the attachment, never from the caller, and no URL
 * is taken.
 * Reading is safe to repeat, so nothing here is claimed or retried specially.
 */

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** Same cap as the email side: 20 MB of attachments per email. */
export const GMAIL_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024

const MAX_NAME_LENGTH = 255
const MAX_PART_DEPTH = 20

// Gmail message ids are hex and attachment ids are long base64url strings. Anything else is
// refused before it reaches a URL, so an id cannot add a path segment or a query.
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const ATTACHMENT_ID_RE = /^[A-Za-z0-9_-]{1,4096}$/
// Gmail part ids look like "0", "1" or "1.2". Only compared, never put in a URL.
const PART_ID_RE = /^[0-9.]{1,64}$/
const MIME_TYPE_RE = /^[A-Za-z0-9][\w!#$&^.+-]{0,126}\/[A-Za-z0-9][\w!#$&^.+-]{0,126}$/

export type GmailAttachmentErrorCode =
	| 'INVALID_INPUT'
	| 'NOT_FOUND'
	| 'TOO_LARGE'
	| 'INSUFFICIENT_SCOPE'
	| 'RECONSENT_REQUIRED'
	| 'REJECTED'
	| 'UNAVAILABLE'

export class GmailAttachmentError extends Error {
	constructor(
		readonly code: GmailAttachmentErrorCode,
		message: string,
	) {
		super(message)
		this.name = 'GmailAttachmentError'
	}
}

interface MessagePart {
	partId?: string
	filename?: string
	mimeType?: string
	body?: { attachmentId?: string; size?: number }
	parts?: MessagePart[]
}

export interface GmailAttachment {
	name: string
	mimeType: string
	bytes: Buffer
}

/** A file name safe to store and to put in a header later: no path parts, no control characters. */
export function sanitizeAttachmentName(raw: string | undefined): string {
	let name = ''
	for (const ch of raw ?? '') {
		const code = ch.charCodeAt(0)
		name += code < 0x20 || code === 0x7f ? ' ' : ch
	}
	name = name.split(/[\\/]/).pop() ?? ''
	name = name.replace(/\s+/g, ' ').trim().replace(/^\.+/, '').trim()
	return name.slice(0, MAX_NAME_LENGTH) || 'attachment'
}

function collectAttachmentParts(part: MessagePart, out: MessagePart[] = [], depth = 0) {
	if (part.body?.attachmentId) out.push(part)
	if (depth >= MAX_PART_DEPTH) return out
	for (const child of part.parts ?? []) collectAttachmentParts(child, out, depth + 1)
	return out
}

/**
 * Gmail attachment ids change between fetches of the same message, so the id the caller read
 * never equals the one our own fetch returns. The part id is stable, so it is matched first;
 * the caller's attachment id is a fallback, and a message with a single attachment needs neither.
 */
function findPart(payload: MessagePart, attachmentId: string, partId?: string): MessagePart | null {
	const candidates = collectAttachmentParts(payload)
	return (
		(partId ? candidates.find((p) => p.partId === partId) : undefined) ??
		candidates.find((p) => p.body?.attachmentId === attachmentId) ??
		(candidates.length === 1 ? candidates[0] : undefined) ??
		null
	)
}

async function gmailGet<T>(accessToken: string, path: string): Promise<T> {
	let res: Response
	try {
		res = await fetch(`${GMAIL_API_BASE}${path}`, {
			headers: { Authorization: `Bearer ${accessToken}` },
		})
	} catch {
		throw new GmailAttachmentError(
			'UNAVAILABLE',
			'The connection to Gmail failed. Nothing was saved; try again.',
		)
	}
	if (res.ok) return (await res.json()) as T

	let detail = res.statusText
	try {
		detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? detail
	} catch {
		// keep the status text
	}
	if (res.status === 401) {
		throw new GmailAttachmentError(
			'RECONSENT_REQUIRED',
			'Gmail rejected the saved login. A person needs to reconnect Gmail in Settings → Integrations.',
		)
	}
	if (res.status === 403 && /scope|insufficient/i.test(detail)) {
		throw new GmailAttachmentError(
			'INSUFFICIENT_SCOPE',
			'This Gmail connection is not allowed to read mail. A person needs to reconnect Gmail in Settings → Integrations.',
		)
	}
	if (res.status === 404) {
		throw new GmailAttachmentError(
			'NOT_FOUND',
			'Gmail has no such message or attachment in the connected account. Read the message again and use the ids it gives now: attachment ids can change between reads.',
		)
	}
	if (res.status >= 400 && res.status < 500) {
		throw new GmailAttachmentError('REJECTED', `Gmail refused the request: ${detail}`)
	}
	throw new GmailAttachmentError(
		'UNAVAILABLE',
		`Gmail returned an error (${res.status}). Nothing was saved; try again.`,
	)
}

const tooLarge = () =>
	new GmailAttachmentError(
		'TOO_LARGE',
		`The attachment is over the ${GMAIL_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB limit, so it was not saved.`,
	)

/** The bytes of one attachment of one message, with the name and type its message part gives. */
export async function fetchGmailAttachment(
	accessToken: string,
	messageId: string,
	attachmentId: string,
	partId?: string,
): Promise<GmailAttachment> {
	if (!MESSAGE_ID_RE.test(messageId)) {
		throw new GmailAttachmentError('INVALID_INPUT', 'That is not a Gmail message id.')
	}
	if (!ATTACHMENT_ID_RE.test(attachmentId)) {
		throw new GmailAttachmentError('INVALID_INPUT', 'That is not a Gmail attachment id.')
	}
	if (partId !== undefined && !PART_ID_RE.test(partId)) {
		throw new GmailAttachmentError('INVALID_INPUT', 'That is not a Gmail part id.')
	}

	// The message tells which part owns the attachment id, and so its name and type.
	const message = await gmailGet<{ payload?: MessagePart }>(
		accessToken,
		`/messages/${messageId}?format=full&fields=payload`,
	)
	const part = message.payload ? findPart(message.payload, attachmentId, partId) : null
	const ownAttachmentId = part?.body?.attachmentId
	if (!part || !ownAttachmentId) {
		throw new GmailAttachmentError(
			'NOT_FOUND',
			'That message has no attachment with that part id or attachment id. Read the message again and pass the partId it lists next to the attachment.',
		)
	}
	if ((part.body?.size ?? 0) > GMAIL_ATTACHMENT_MAX_BYTES) throw tooLarge()

	// The bytes are fetched with the id from our own fetch of the message, which Gmail accepts;
	// the caller's id may be stale by now.
	const data = await gmailGet<{ data?: string }>(
		accessToken,
		`/messages/${messageId}/attachments/${encodeURIComponent(ownAttachmentId)}`,
	)
	const bytes = Buffer.from(data.data ?? '', 'base64url')
	if (bytes.byteLength > GMAIL_ATTACHMENT_MAX_BYTES) throw tooLarge()

	const mimeType = part.mimeType && MIME_TYPE_RE.test(part.mimeType) ? part.mimeType : null
	return {
		name: sanitizeAttachmentName(part.filename),
		mimeType: mimeType ?? 'application/octet-stream',
		bytes,
	}
}

/**
 * Stores the bytes as a workspace file, the way create_file does: row first, then storage,
 * and the row is removed again if storage fails.
 */
export async function storeAttachmentFile(
	deps: { db: Database; storage: StorageProvider },
	input: { workspaceId: string; actorId: string } & GmailAttachment,
): Promise<typeof files.$inferSelect> {
	const fileId = randomUUID()
	const storageKey = fileStorageKey(input.workspaceId, fileId)
	const [row] = await deps.db
		.insert(files)
		.values({
			id: fileId,
			workspaceId: input.workspaceId,
			name: input.name,
			description: null,
			mimeType: input.mimeType,
			sizeBytes: input.bytes.byteLength,
			storageKey,
			contentHash: sha256Hex(input.bytes),
			createdBy: input.actorId,
		})
		.returning()
	if (!row) throw new Error('Failed to insert files row')
	try {
		await deps.storage.put(storageKey, input.bytes)
	} catch (err) {
		logger.error('Gmail attachment storage put failed; rolling back file row', {
			workspaceId: input.workspaceId,
			fileId,
			error: String(err),
		})
		await deps.db.delete(files).where(eq(files.id, fileId))
		throw err
	}
	return row
}
