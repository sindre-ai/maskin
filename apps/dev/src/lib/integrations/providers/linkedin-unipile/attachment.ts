import type { Database } from '@maskin/db'
import { files } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { LinkedInIntegrationError } from './errors'

/**
 * The one file a LinkedIn message may carry: a workspace file named on the approved object
 * (`attachment_file_id`), checked here and nowhere else. Nothing about it comes from the
 * caller of a tool, so the file sent is the file a person approved.
 *
 *  - It must be a file of the caller's own workspace.
 *  - Its type is read from its first bytes, never from its name or stored mime type, so a
 *    renamed file cannot pass as something else. PDF, PNG and JPEG only.
 *  - At most 10 MB.
 *  - Refused when the file row changed after the approval, since an approval covers the file
 *    id and not what the file holds.
 */

export const LINKEDIN_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024

/** The shape the Unipile client sends: base64 bytes with an explicit type and name. */
export interface LinkedInFileAttachment {
	content: string
	content_type: 'application/pdf' | 'image/png' | 'image/jpeg'
	filename: string
}

type AttachmentType = LinkedInFileAttachment['content_type']

const SIGNATURES: Array<{ type: AttachmentType; bytes: number[] }> = [
	{ type: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
	{ type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
	{ type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
]

/** The type the bytes say the file is, or null when it is none of the three. */
export function sniffAttachmentType(bytes: Uint8Array): AttachmentType | null {
	for (const { type, bytes: signature } of SIGNATURES) {
		if (bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b)) return type
	}
	return null
}

const TOO_BIG = 'The attachment is over the 10 MB limit.'

export async function loadApprovedAttachment(
	deps: { db: Database; storage: StorageProvider | undefined },
	input: { workspaceId: string; fileId: string; approvedAt: Date | null },
): Promise<LinkedInFileAttachment> {
	const [file] = await deps.db
		.select()
		.from(files)
		.where(and(eq(files.id, input.fileId), eq(files.workspaceId, input.workspaceId)))
		.limit(1)
	if (!file) {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			'The attachment is not a file in this workspace.',
		)
	}
	// An approval with no time cannot show the file is unchanged, so it does not pass.
	if (!input.approvedAt || file.updatedAt.getTime() > input.approvedAt.getTime()) {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			'The attachment changed after it was approved. Ask a person to approve it again.',
		)
	}
	if (file.sizeBytes > LINKEDIN_ATTACHMENT_MAX_BYTES) {
		throw new LinkedInIntegrationError('INVALID_INPUT', TOO_BIG)
	}
	if (!deps.storage) {
		throw new LinkedInIntegrationError(
			'LINKEDIN_UNAVAILABLE',
			'File storage is not available, so the attachment cannot be sent.',
		)
	}
	const bytes = await deps.storage.get(file.storageKey)
	if (bytes.length > LINKEDIN_ATTACHMENT_MAX_BYTES) {
		throw new LinkedInIntegrationError('INVALID_INPUT', TOO_BIG)
	}
	const type = sniffAttachmentType(bytes)
	if (!type) {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			'The attachment is not a PDF, PNG or JPEG. Those are the only files LinkedIn messages can carry here.',
		)
	}
	return { content: bytes.toString('base64'), content_type: type, filename: file.name }
}
