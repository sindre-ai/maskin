import type { Database } from '@maskin/db'
import { files } from '@maskin/db/schema'
import type { ObjectPreview } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, inArray } from 'drizzle-orm'

/**
 * The files an email draft carries: workspace files named on the object in
 * `metadata.attachment_file_ids`, read here and nowhere else, for both send routes (Gmail
 * and Resend). Nothing about them comes from the caller of a tool, so the files sent are the
 * files a person approved.
 *
 *  - At most 5 files and 20 MB in total.
 *  - Every id must be a file of the caller's own workspace.
 *  - Refused when a file changed after the approval: the approval is bound to the file ids
 *    (they are a detail line of the preview, so adding, removing or swapping one withdraws it),
 *    and this check covers a file that was overwritten under the same id.
 *
 * A refusal throws {@link EmailAttachmentError} before anything is claimed or sent.
 */

export const EMAIL_ATTACHMENT_MAX_FILES = 5
export const EMAIL_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024

/** The detail line of the preview that lists the files. The hash covers its value (the ids). */
export const ATTACHMENTS_DETAIL_LABEL = 'Attachments'

export class EmailAttachmentError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'EmailAttachmentError'
	}
}

export interface EmailAttachment {
	filename: string
	contentType: string
	content: Buffer
}

/** The file ids on a draft: a list, or ids separated by commas. Order kept, repeats dropped. */
export function readAttachmentIds(metadata: unknown): string[] {
	const raw = (metadata as Record<string, unknown> | null)?.attachment_file_ids
	const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []
	const ids = parts.flatMap((p) => (typeof p === 'string' && p.trim() ? [p.trim()] : []))
	return [...new Set(ids)]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i

export async function loadEmailAttachments(
	deps: { db: Database; storage: StorageProvider | undefined },
	input: {
		workspaceId: string
		ids: string[]
		approvedAt: Date | null
		/**
		 * True when no person approved the email (an agent set to always allow sends it): the files
		 * are read as they are now, with the same count, size and type checks.
		 */
		unapproved?: boolean
	},
): Promise<EmailAttachment[]> {
	if (input.ids.length === 0) return []
	if (input.ids.length > EMAIL_ATTACHMENT_MAX_FILES) {
		throw new EmailAttachmentError(
			`An email can carry at most ${EMAIL_ATTACHMENT_MAX_FILES} files, this one lists ${input.ids.length}. Nothing was sent.`,
		)
	}
	const bad = input.ids.find((id) => !UUID.test(id))
	if (bad) {
		throw new EmailAttachmentError(
			`"${bad}" in attachment_file_ids is not a file id. Nothing was sent.`,
		)
	}
	const rows = await deps.db
		.select()
		.from(files)
		.where(and(eq(files.workspaceId, input.workspaceId), inArray(files.id, input.ids)))
	const byId = new Map(rows.map((r) => [r.id, r]))
	const ordered = input.ids.map((id) => {
		const file = byId.get(id)
		if (!file) {
			throw new EmailAttachmentError(
				`The attachment ${id} is not a file in this workspace. Nothing was sent.`,
			)
		}
		return file
	})
	for (const file of ordered) {
		// An approval with no time cannot show the file is unchanged, so it does not pass.
		if (
			!input.unapproved &&
			(!input.approvedAt || file.updatedAt.getTime() > input.approvedAt.getTime())
		) {
			throw new EmailAttachmentError(
				`The attachment "${file.name}" changed after it was approved. Ask a person to approve the email again. Nothing was sent.`,
			)
		}
	}
	const total = ordered.reduce((sum, f) => sum + f.sizeBytes, 0)
	if (total > EMAIL_ATTACHMENT_MAX_BYTES) {
		throw new EmailAttachmentError(
			'The attachments are over the 20 MB limit in total. Nothing was sent.',
		)
	}
	if (!deps.storage) {
		throw new EmailAttachmentError(
			'File storage is not available, so the attachments cannot be sent. Nothing was sent.',
		)
	}
	const attachments: EmailAttachment[] = []
	let read = 0
	for (const file of ordered) {
		const content = await deps.storage.get(file.storageKey)
		read += content.length
		if (read > EMAIL_ATTACHMENT_MAX_BYTES) {
			throw new EmailAttachmentError(
				'The attachments are over the 20 MB limit in total. Nothing was sent.',
			)
		}
		attachments.push({
			filename: file.name,
			contentType: MIME_TYPE.test(file.mimeType) ? file.mimeType : 'application/octet-stream',
			content,
		})
	}
	return attachments
}

/**
 * Shows file names where a preview lists file ids. Display only: the content hash was
 * computed from the ids and is left as it is, so an approval does not depend on a name.
 */
export async function withAttachmentNames(
	db: Database,
	workspaceId: string,
	preview: ObjectPreview,
): Promise<ObjectPreview> {
	if (preview.kind !== 'email') return preview
	const line = preview.details.find((d) => d.label === ATTACHMENTS_DETAIL_LABEL)
	if (!line) return preview
	const ids = line.value.split(',').map((s) => s.trim())
	const valid = ids.filter((id) => UUID.test(id))
	const rows = valid.length
		? await db
				.select({ id: files.id, name: files.name })
				.from(files)
				.where(and(eq(files.workspaceId, workspaceId), inArray(files.id, valid)))
		: []
	const names = new Map(rows.map((r) => [r.id, r.name]))
	const shown = ids.map((id) => names.get(id) ?? `missing file (${id})`).join(', ')
	return {
		...preview,
		details: preview.details.map((d) => (d === line ? { ...d, value: shown } : d)),
	}
}
