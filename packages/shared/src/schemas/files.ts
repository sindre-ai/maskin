import { z } from 'zod'

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB

export const mimeTypeSchema = z
	.string()
	.min(3)
	.max(255)
	.regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i, 'Invalid MIME type format')

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
	path: (string | number)[] = ['content'],
) {
	if (encoding === 'base64') {
		if (content.length % 4 !== 0 || !base64Re.test(content)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Content must be base64-encoded',
				path,
			})
			return
		}
		if (decodedByteLength(content) > MAX_FILE_SIZE_BYTES) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `Content exceeds ${MAX_FILE_SIZE_BYTES} bytes`,
				path,
			})
		}
		return
	}
	if (utf8ByteLength(content) > MAX_FILE_SIZE_BYTES) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: `Content exceeds ${MAX_FILE_SIZE_BYTES} bytes`,
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

export const createFileSchema = z
	.object({
		name: fileNameSchema,
		description: z.string().max(1000).nullable().optional(),
		mime_type: mimeTypeSchema,
		content: z.string(),
		encoding: fileEncodingSchema.default('utf8'),
	})
	.superRefine((data, ctx) => validateContent(data.content, data.encoding, ctx))

export type CreateFileInput = z.infer<typeof createFileSchema>

export const updateFileSchema = z
	.object({
		name: fileNameSchema.optional(),
		description: z.string().max(1000).nullable().optional(),
		mime_type: mimeTypeSchema.optional(),
		content: z.string().optional(),
		encoding: fileEncodingSchema.optional(),
	})
	.refine(
		(o) => Object.values(o).some((v) => v !== undefined),
		'At least one field must be provided',
	)
	.superRefine((data, ctx) => {
		if (data.content === undefined) return
		validateContent(data.content, data.encoding ?? 'utf8', ctx)
	})

export type UpdateFileInput = z.infer<typeof updateFileSchema>

export const fileListItemSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	name: z.string(),
	description: z.string().nullable(),
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
})

export type FileDetail = z.infer<typeof fileDetailSchema>
