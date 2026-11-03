/**
 * R11-B · LinkedIn attachments — canonical Zod schemas per spec §4.2.
 *
 * Every LinkedIn attachment travels through the Unipile v2 wire as a base64
 * blob, with the MIME type as an explicit field (no sniffing) and a filename
 * so LinkedIn can present it in the feed. The interesting invariant is on the
 * SHAPE OF THE ARRAY, not on any individual attachment:
 *
 *   LinkedIn accepts EITHER
 *     - up to 9 images together (a carousel), OR
 *     - exactly one non-image (a video OR a document).
 *
 *   Mixing an image with a video, or a document with either, is rejected by
 *   LinkedIn's own API with INVALID_INPUT. Enforcing the rule here lets a
 *   caller find out before spending a Unipile round-trip and before its
 *   idempotency claim burns a ledger row for a call that cannot land.
 *
 * The concrete MIME lists mirror the reference — three enumerated sets that
 * combine into one `content_type` union. When LinkedIn adds a supported type,
 * the ONLY change needed here is a new entry in the matching MIME list; every
 * downstream that imports `linkedinAttachmentSchema` picks it up.
 *
 * `send_mode` is optional and messaging-only — LinkedIn's Unipile v2 messaging
 * surface lets a caller choose between `native` (inline attachment in the DM)
 * and `file` (Unipile-hosted file link). Posts freeze at publish and cannot
 * accept `send_mode` at all, so the field is left OPTIONAL on the base
 * attachment schema; per-tool schemas at the tool boundary decide whether they
 * accept it (send_message: yes; publish_post: passed through but only
 * meaningful on message attachments).
 *
 * NOT covered here (deliberate per spec §4.3, residual R8):
 *   - Two-step media upload (create + attach). Everything currently flows
 *     as raw base64 in-band under the 10 MB Unipile ceiling.
 */

import { z } from 'zod'

/**
 * LinkedIn-accepted image MIME types. LinkedIn's docs allow gif and webp on
 * feed publishes, both surfaced here so a caller does not have to convert.
 */
export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const

/** LinkedIn-accepted video MIME types. LinkedIn accepts mp4 and quicktime. */
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime'] as const

/**
 * LinkedIn-accepted document MIME types — PDF plus the two Office XML formats
 * for Word and PowerPoint. LinkedIn does NOT accept spreadsheets on the feed
 * surface, so xlsx is deliberately absent.
 */
export const DOCUMENT_MIME_TYPES = [
	'application/pdf',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const

/**
 * The concatenated MIME union. Kept in this exact order (images → videos →
 * documents) so the union-of-literals order in generated tool schemas stays
 * diff-stable — a `tools/list` diff across restarts should not shuffle.
 */
export const LINKEDIN_ATTACHMENT_MIME_TYPES = [
	...IMAGE_MIME_TYPES,
	...VIDEO_MIME_TYPES,
	...DOCUMENT_MIME_TYPES,
] as const

export type LinkedInAttachmentMimeType = (typeof LINKEDIN_ATTACHMENT_MIME_TYPES)[number]

/**
 * LinkedIn-permitted send modes for messaging attachments.
 *
 *   - `native`: attachment is inlined in the DM as if the sender had dragged
 *     the file into the LinkedIn compose box.
 *   - `file`:   attachment is uploaded to Unipile and delivered as a hosted
 *     file link; LinkedIn renders it as an attached file entry rather than
 *     an inline preview.
 *
 * Unset defaults to LinkedIn's own behaviour, which is `native` for images and
 * `file` for everything else — same default the messaging surface applies
 * server-side.
 */
export const LINKEDIN_ATTACHMENT_SEND_MODES = ['native', 'file'] as const

export type LinkedInAttachmentSendMode = (typeof LINKEDIN_ATTACHMENT_SEND_MODES)[number]

/**
 * One attachment. `content` is base64-encoded bytes (Unipile v2 accepts raw
 * base64 in-band up to the 10 MB decoded ceiling — NOT a URL, NOT a Unipile
 * media id). `content_type` and `filename` are mandatory: LinkedIn's own feed
 * uses both to render the entry, so leaving them off silently degrades the
 * post.
 */
export const linkedinAttachmentSchema = z
	.object({
		content: z
			.string()
			.min(1)
			.describe(
				'Base64-encoded bytes of the attachment. NOT a URL, NOT a Unipile media id — Unipile v2 accepts raw base64 in-band. Max 10 MB after base64 decode; Unipile enforces the limit and returns INVALID_INPUT if exceeded. Node.js: fileBuffer.toString("base64").',
			),
		content_type: z
			.enum(LINKEDIN_ATTACHMENT_MIME_TYPES)
			.describe(
				'MIME type of the attachment. Must be one of the LinkedIn-supported image / video / document types.',
			),
		filename: z
			.string()
			.min(1)
			.max(255)
			.describe(
				'File name LinkedIn shows on the post/message entry (e.g. "quarterly-report.pdf"). 1-255 chars.',
			),
		send_mode: z
			.enum(LINKEDIN_ATTACHMENT_SEND_MODES)
			.optional()
			.describe(
				'Messaging-only: "native" (inline in the DM) or "file" (Unipile-hosted file link). Ignored on post attachments — posts freeze at publish and take LinkedIn\'s own rendering.',
			),
	})
	.describe(
		'LinkedIn attachment. LinkedIn allows EITHER multiple images (carousel, up to 9) OR exactly one non-image (video OR document). Mixing an image with a video in the same array is rejected by LinkedIn with INVALID_INPUT.',
	)

export type LinkedInAttachment = z.infer<typeof linkedinAttachmentSchema>

/**
 * The mixed-type refinement message. Exported so tests can assert against it
 * as a constant (and so the message stays byte-for-byte the same across every
 * caller that surfaces it — agents pattern-match on the exact string).
 */
export const LINKEDIN_ATTACHMENTS_MIXED_TYPES_MESSAGE =
	'LinkedIn accepts either multiple images (up to 9, carousel) OR exactly one non-image (video or document). Mixing types is rejected.'

/**
 * Return true iff the attachment carries an image content_type. Exported so
 * callers can reuse the same predicate the refinement uses, rather than
 * re-deriving the "is-image" rule inline.
 */
export function isImageAttachment(att: LinkedInAttachment): boolean {
	return att.content_type.startsWith('image/')
}

/**
 * The full attachments array. `.max(9)` bounds the carousel size; the
 * `.refine` enforces the mixed-type rule. An EMPTY array is treated as valid
 * so a caller can pass `attachments: []` interchangeably with omitting the
 * field entirely (agents build the array dynamically and often end up with
 * zero entries on a text-only call).
 */
export const linkedinAttachmentsArraySchema = z
	.array(linkedinAttachmentSchema)
	.max(9)
	.refine(
		(atts) => {
			if (atts.length === 0) return true
			const allImages = atts.every(isImageAttachment)
			const isSingleNonImage =
				atts.length === 1 && !isImageAttachment(atts[0] as LinkedInAttachment)
			return allImages || isSingleNonImage
		},
		{ message: LINKEDIN_ATTACHMENTS_MIXED_TYPES_MESSAGE },
	)

export type LinkedInAttachmentsArray = z.infer<typeof linkedinAttachmentsArraySchema>
