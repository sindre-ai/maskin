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
 *    renamed file cannot pass as something else. PDF, PNG and JPEG for messages; PNG, JPEG,
 *    MP4 and MOV for a post.
 *  - At most 10 MB, or 64 MB for a video in a post.
 *  - Refused when the file row changed after the approval, since an approval covers the file
 *    id and not what the file holds.
 */

export const LINKEDIN_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024

/**
 * A video in a post. 51.2 MB is the largest size proven against Unipile, and the server holds
 * the file, its base64 text and the JSON body at once, so this stays well under 100 MB. Raise
 * it only after a larger real test.
 */
export const LINKEDIN_VIDEO_MAX_BYTES = 64 * 1024 * 1024

/** The shape the Unipile client sends: base64 bytes with an explicit type and name. */
export interface LinkedInFileAttachment {
	content: string
	content_type: 'application/pdf' | 'image/png' | 'image/jpeg' | 'video/mp4' | 'video/quicktime'
	filename: string
}

type AttachmentType = LinkedInFileAttachment['content_type']

export function isVideoType(type: AttachmentType): boolean {
	return type === 'video/mp4' || type === 'video/quicktime'
}

/**
 * The file-type brands an MP4 or MOV carries after its "ftyp" marker. Photos in the same box
 * format (HEIC, AVIF) carry other brands and are not videos, so they are not on this list.
 */
const MP4_BRANDS = new Set([
	'isom',
	'iso2',
	'iso3',
	'iso4',
	'iso5',
	'iso6',
	'mp41',
	'mp42',
	'avc1',
	'dash',
	'M4V ',
	'M4VH',
	'M4VP',
	'MSNV',
	'f4v ',
])

function sniffVideoType(bytes: Uint8Array): 'video/mp4' | 'video/quicktime' | null {
	if (bytes.length < 12) return null
	const ascii = (from: number) => String.fromCharCode(...bytes.subarray(from, from + 4))
	if (ascii(4) !== 'ftyp') return null
	const brand = ascii(8)
	if (brand === 'qt  ') return 'video/quicktime'
	return MP4_BRANDS.has(brand) ? 'video/mp4' : null
}

const SIGNATURES: Array<{ type: AttachmentType; bytes: number[] }> = [
	{ type: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
	{ type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
	{ type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
]

/** The type the bytes say the file is, or null when it is none of the five. */
export function sniffAttachmentType(bytes: Uint8Array): AttachmentType | null {
	for (const { type, bytes: signature } of SIGNATURES) {
		if (bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b)) return type
	}
	return sniffVideoType(bytes)
}

const TOO_BIG = 'The attachment is over the 10 MB limit.'
const IMAGE_TOO_BIG = 'The image is over the 10 MB limit.'
const VIDEO_TOO_BIG = 'The video is over the 64 MB limit.'

export async function loadApprovedAttachment(
	deps: { db: Database; storage: StorageProvider | undefined },
	input: { workspaceId: string; fileId: string; approvedAt: Date | null },
): Promise<LinkedInFileAttachment> {
	return loadWorkspaceFile(deps, {
		workspaceId: input.workspaceId,
		fileId: input.fileId,
		approval: { approvedAt: input.approvedAt },
		allowed: ['application/pdf', 'image/png', 'image/jpeg'],
		notAllowed:
			'The attachment is not a PDF, PNG or JPEG. Those are the only files LinkedIn messages can carry here.',
	})
}

/**
 * A message attachment for an agent that sends without a person's approval: the file is read
 * as it is now, with the same workspace, type, size and first-bytes checks as above.
 */
export async function loadAttachment(
	deps: { db: Database; storage: StorageProvider | undefined },
	input: { workspaceId: string; fileId: string },
): Promise<LinkedInFileAttachment> {
	return loadWorkspaceFile(deps, {
		workspaceId: input.workspaceId,
		fileId: input.fileId,
		allowed: ['application/pdf', 'image/png', 'image/jpeg'],
		notAllowed:
			'The attachment is not a PDF, PNG or JPEG. Those are the only files LinkedIn messages can carry here.',
	})
}

/**
 * An image or a video a caller asked for on a public post. A post has no approval step of its
 * own here, so the file is read as it is now: same workspace, size and first-bytes checks as
 * above. PNG and JPEG up to 10 MB, MP4 and MOV up to 64 MB.
 */
export async function loadPostMedia(
	deps: { db: Database; storage: StorageProvider | undefined },
	input: { workspaceId: string; fileId: string },
): Promise<LinkedInFileAttachment> {
	return loadWorkspaceFile(deps, {
		...input,
		allowed: ['image/png', 'image/jpeg', 'video/mp4', 'video/quicktime'],
		notAllowed:
			'The file is not a PNG or JPEG image or an MP4 or MOV video. Those are the only files a post can carry here.',
	})
}

async function loadWorkspaceFile(
	deps: { db: Database; storage: StorageProvider | undefined },
	input: {
		workspaceId: string
		fileId: string
		/** Set when a person's approval covers the file: refused if the file changed after it. */
		approval?: { approvedAt: Date | null }
		allowed: AttachmentType[]
		notAllowed: string
	},
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
	if (
		input.approval &&
		(!input.approval.approvedAt || file.updatedAt.getTime() > input.approval.approvedAt.getTime())
	) {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			'The attachment changed after it was approved. Ask a person to approve it again.',
		)
	}
	// A file that no allowed type could hold is refused before it is read. The exact cap for the
	// type the bytes show is checked once they are read.
	const videoAllowed = input.allowed.some(isVideoType)
	const largestAllowed = videoAllowed ? LINKEDIN_VIDEO_MAX_BYTES : LINKEDIN_ATTACHMENT_MAX_BYTES
	if (file.sizeBytes > largestAllowed) {
		throw new LinkedInIntegrationError('INVALID_INPUT', videoAllowed ? VIDEO_TOO_BIG : TOO_BIG)
	}
	if (!deps.storage) {
		throw new LinkedInIntegrationError(
			'LINKEDIN_UNAVAILABLE',
			'File storage is not available, so the attachment cannot be sent.',
		)
	}
	const bytes = await deps.storage.get(file.storageKey)
	if (bytes.length > largestAllowed) {
		throw new LinkedInIntegrationError('INVALID_INPUT', videoAllowed ? VIDEO_TOO_BIG : TOO_BIG)
	}
	const type = sniffAttachmentType(bytes)
	if (!type || !input.allowed.includes(type)) {
		throw new LinkedInIntegrationError('INVALID_INPUT', input.notAllowed)
	}
	if (!isVideoType(type) && bytes.length > LINKEDIN_ATTACHMENT_MAX_BYTES) {
		throw new LinkedInIntegrationError('INVALID_INPUT', videoAllowed ? IMAGE_TOO_BIG : TOO_BIG)
	}
	return { content: bytes.toString('base64'), content_type: type, filename: file.name }
}
