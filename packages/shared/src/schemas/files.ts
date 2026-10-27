import { z } from 'zod'

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB

// Video gets a higher cap than other files. Uploads are still a single base64
// JSON request held in memory (no streaming), so this stays well short of what
// storage could hold: 50 MB of video is ~67 MB on the wire.
export const MAX_VIDEO_FILE_SIZE_BYTES = 50 * 1024 * 1024 // 50 MB

// Above this size a file never travels through the API as base64 JSON. It is
// uploaded straight to storage in parts (presigned URLs) and, when read, comes
// back as a download URL instead of inline content. Same number as the video
// cap on purpose: everything the JSON path accepts stays on it unchanged.
export const MAX_INLINE_FILE_SIZE_BYTES = MAX_VIDEO_FILE_SIZE_BYTES

// Ceiling for the direct upload path. Raising it later is a one-line change here:
// storage allows 5 TiB per object and part sizes scale with the file (see
// `planFileUploadParts`), and `files.size_bytes` is a bigint.
export const MAX_LARGE_FILE_SIZE_BYTES = 1024 * 1024 * 1024 // 1 GiB

const MIN_UPLOAD_PART_BYTES = 16 * 1024 * 1024 // 16 MiB; S3's own minimum is 5 MiB
const MAX_UPLOAD_PARTS = 10_000 // S3's limit

/** How a file of `sizeBytes` is cut into parts for a multipart upload. */
export function planFileUploadParts(sizeBytes: number): { partSize: number; partCount: number } {
	const MiB = 1024 * 1024
	const needed = Math.ceil(sizeBytes / MAX_UPLOAD_PARTS / MiB) * MiB
	const partSize = Math.max(MIN_UPLOAD_PART_BYTES, needed)
	return { partSize, partCount: Math.max(1, Math.ceil(sizeBytes / partSize)) }
}

export function isVideoMimeType(mime: string): boolean {
	return mime.toLowerCase().startsWith('video/')
}

/** Upload cap for a file of this MIME type. Unknown type falls back to the general cap. */
export function maxFileSizeBytesFor(mime: string | undefined): number {
	return mime && isVideoMimeType(mime) ? MAX_VIDEO_FILE_SIZE_BYTES : MAX_FILE_SIZE_BYTES
}

export const mimeTypeSchema = z
	.string()
	.min(3)
	.max(255)
	.regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i, 'Invalid MIME type format')

// What a file is for. `briefing` is the only kind today: an HTML page the Chief of
// Staff (or a loop) writes to be read in For you.
export const fileKindSchema = z.enum(['briefing'])
export type FileKind = z.infer<typeof fileKindSchema>

export const fileNameSchema = z.string().trim().min(1).max(255)

export const fileEncodingSchema = z.enum(['base64', 'utf8'])
export type FileEncoding = z.infer<typeof fileEncodingSchema>

const base64Re = /^[A-Za-z0-9+/]*={0,2}$/

function decodedByteLength(b64: string): number {
	if (b64.length === 0) return 0
	const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
	return (b64.length * 3) / 4 - padding
}

function utf8ByteLength(s: string): number {
	// Node and browsers diverge on `Buffer`, so count via TextEncoder which is
	// available in both runtimes that import this shared schema.
	return new TextEncoder().encode(s).byteLength
}

function validateContent(
	content: string,
	encoding: FileEncoding,
	ctx: z.RefinementCtx,
	maxBytes: number,
	path: (string | number)[] = ['content'],
) {
	if (encoding === 'base64') {
		if (content.length % 4 !== 0 || !base64Re.test(content)) {
			const lengthNote = content.length % 4 === 0 ? 'a multiple of 4' : 'not a multiple of 4'
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `Content must be base64-encoded (received ${content.length} characters; length is ${lengthNote})`,
				path,
			})
			return
		}
		if (decodedByteLength(content) > maxBytes) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `Content exceeds ${maxBytes} bytes`,
				path,
			})
		}
		return
	}
	if (utf8ByteLength(content) > maxBytes) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: `Content exceeds ${maxBytes} bytes`,
			path,
		})
	}
}

// MIME types whose stored bytes round-trip as UTF-8 text. Mirrors the frontend's
// `isPlainText` set in apps/web/src/lib/file-utils.ts.
const TEXT_MIME_EXACT = new Set([
	'application/json',
	'application/xml',
	'application/xhtml+xml',
	'application/javascript',
	'application/ecmascript',
	'application/yaml',
	'application/x-yaml',
	'text/ecmascript',
])

export function isTextMimeType(mime: string): boolean {
	return mime.startsWith('text/') || TEXT_MIME_EXACT.has(mime)
}

// Max comment length — kept in sync with sanitizeAnnotations in apps/web.
export const MAX_ANNOTATION_COMMENT_LENGTH = 500
// Cap the number of pins per file so the jsonb blob stays bounded.
export const MAX_ANNOTATIONS_PER_FILE = 200

// A single pinned review comment on a file. `pinNumber` and `position` are the
// UI's pin badge + drop location; they're optional so non-UI writers (or older
// rows) can omit them and let the viewer backfill from `bounds`.
export const fileAnnotationSchema = z.object({
	id: z.string().max(100),
	pinNumber: z.number().int().positive().optional(),
	selector: z.string().max(1000).default(''),
	bounds: z.object({
		x: z.number(),
		y: z.number(),
		w: z.number(),
		h: z.number(),
	}),
	comment: z.string().max(MAX_ANNOTATION_COMMENT_LENGTH),
	position: z.object({ x: z.number(), y: z.number() }).optional(),
})

export type FileAnnotation = z.infer<typeof fileAnnotationSchema>

export const fileAnnotationsSchema = z.array(fileAnnotationSchema).max(MAX_ANNOTATIONS_PER_FILE)

// sha256 of the stored bytes, lowercase hex. The server computes it; clients
// only echo it back as if_match.
export const contentHashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a sha256 hex digest')

export const createFileSchema = z
	.object({
		name: fileNameSchema,
		description: z.string().max(1000).nullable().optional(),
		kind: fileKindSchema.nullable().optional(),
		mime_type: mimeTypeSchema,
		content: z.string(),
		encoding: fileEncodingSchema.default('utf8'),
	})
	.superRefine((data, ctx) =>
		validateContent(data.content, data.encoding, ctx, maxFileSizeBytesFor(data.mime_type)),
	)

export type CreateFileInput = z.infer<typeof createFileSchema>

export const updateFileSchema = z
	.object({
		name: fileNameSchema.optional(),
		description: z.string().max(1000).nullable().optional(),
		kind: fileKindSchema.nullable().optional(),
		mime_type: mimeTypeSchema.optional(),
		content: z.string().optional(),
		encoding: fileEncodingSchema.optional(),
		annotations: fileAnnotationsSchema.optional(),
		// Optional version check: the content hash the caller last read. A
		// mismatch with the stored hash is refused with 409 and nothing is
		// written. Omitted = last write wins (MCP update_file, scripts).
		if_match: contentHashSchema.optional(),
	})
	.refine(
		(o) => Object.entries(o).some(([key, v]) => key !== 'if_match' && v !== undefined),
		'At least one field must be provided',
	)
	.superRefine((data, ctx) => {
		if (data.content === undefined) return
		// Without mime_type the stored type isn't known here, so the general cap
		// applies. Replacing a video's bytes needs mime_type in the same request.
		validateContent(data.content, data.encoding ?? 'utf8', ctx, maxFileSizeBytesFor(data.mime_type))
	})

export type UpdateFileInput = z.infer<typeof updateFileSchema>

export const fileListItemSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	name: z.string(),
	description: z.string().nullable(),
	kind: fileKindSchema.nullable(),
	mimeType: z.string(),
	sizeBytes: z.number().int().nonnegative(),
	storageKey: z.string(),
	createdBy: z.string().uuid(),
	createdAt: z.string(),
	updatedAt: z.string(),
})

export type FileListItem = z.infer<typeof fileListItemSchema>

export const fileDetailSchema = fileListItemSchema.extend({
	content: z.string(),
	encoding: fileEncodingSchema,
	url: z.string().url(),
	annotations: fileAnnotationsSchema.default([]),
	// Current content hash, to be echoed as if_match on the next save. Null only
	// for a row nobody has hashed yet; GET fills it in on first read.
	contentHash: contentHashSchema.nullable().optional(),
	// Set on create/update responses when the save succeeded but the viewer
	// will not render the content as written (e.g. outside resources in HTML).
	warning: z.string().optional(),
})

export type FileDetail = z.infer<typeof fileDetailSchema>

// -- Large files: direct-to-storage multipart upload ------------------------
// 1. POST /files/uploads            → upload id + one presigned PUT URL per part
// 2. PUT each part to its URL       → read the ETag response header of each
// 3. POST /files/uploads/:id/complete with the ETags → the file
// DELETE /files/uploads/:id abandons an upload.

export const startFileUploadSchema = z.object({
	name: fileNameSchema,
	description: z.string().max(1000).nullable().optional(),
	kind: fileKindSchema.nullable().optional(),
	mime_type: mimeTypeSchema,
	size_bytes: z
		.number()
		.int()
		.positive()
		.max(MAX_LARGE_FILE_SIZE_BYTES, `File exceeds ${MAX_LARGE_FILE_SIZE_BYTES} bytes`),
})

export type StartFileUploadInput = z.infer<typeof startFileUploadSchema>

export const fileUploadSessionSchema = z.object({
	upload_id: z.string().uuid(),
	file_id: z.string().uuid(),
	part_size: z.number().int().positive(),
	parts: z.array(z.object({ part_number: z.number().int().positive(), url: z.string().url() })),
	expires_at: z.string(),
})

export type FileUploadSession = z.infer<typeof fileUploadSessionSchema>

export const completeFileUploadSchema = z.object({
	parts: z
		.array(
			z.object({
				part_number: z.number().int().min(1).max(10_000),
				etag: z.string().min(1).max(200),
			}),
		)
		.min(1)
		.max(10_000),
})

export type CompleteFileUploadInput = z.infer<typeof completeFileUploadSchema>
