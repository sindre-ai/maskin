import { z } from 'zod'

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB

export const mimeTypeSchema = z
	.string()
	.min(3)
	.max(255)
	.regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i, 'Invalid MIME type format')

export const fileNameSchema = z.string().trim().min(1).max(255)

const base64Re = /^[A-Za-z0-9+/]*={0,2}$/

export const fileContentBase64Schema = z
	.string()
	.refine((s) => s.length % 4 === 0 && base64Re.test(s), 'Content must be base64-encoded')
	.refine(
		(s) => decodedByteLength(s) <= MAX_FILE_SIZE_BYTES,
		`Content exceeds ${MAX_FILE_SIZE_BYTES} bytes`,
	)

function decodedByteLength(b64: string): number {
	if (b64.length === 0) return 0
	const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
	return (b64.length * 3) / 4 - padding
}

export const createFileSchema = z.object({
	name: fileNameSchema,
	description: z.string().max(1000).nullable().optional(),
	mime_type: mimeTypeSchema,
	content: fileContentBase64Schema,
})

export type CreateFileInput = z.infer<typeof createFileSchema>

export const updateFileSchema = z
	.object({
		name: fileNameSchema.optional(),
		description: z.string().max(1000).nullable().optional(),
		mime_type: mimeTypeSchema.optional(),
		content: fileContentBase64Schema.optional(),
	})
	.refine(
		(o) => Object.values(o).some((v) => v !== undefined),
		'At least one field must be provided',
	)

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
	url: z.string().url(),
	downloadUrl: z.string().url(),
})

export type FileDetail = z.infer<typeof fileDetailSchema>
