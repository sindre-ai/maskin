import { z } from 'zod'
import { safeMetadataSchema } from './primitives'

export const objectTypeSchema = z
	.string()
	.min(1)
	.max(50)
	.regex(/^[a-z][a-z0-9_]*$/)
export type ObjectType = z.infer<typeof objectTypeSchema>

export const createObjectSchema = z.object({
	id: z.string().uuid().optional(),
	type: objectTypeSchema,
	title: z.string().optional(),
	content: z.string().optional(),
	status: z.string(),
	metadata: safeMetadataSchema.optional(),
	owner: z.string().uuid().optional(),
})

export const updateObjectSchema = z.object({
	title: z.string().optional(),
	content: z.string().optional(),
	status: z.string().optional(),
	metadata: safeMetadataSchema.optional(),
	owner: z.string().uuid().nullable().optional(),
})

/** Known built-in sort columns — keep in sync with sortColumns in apps/dev/src/routes/objects.ts */
export const KNOWN_SORT_COLUMNS = [
	'createdAt',
	'updatedAt',
	'title',
	'status',
	'type',
	'owner',
	'createdBy',
] as const

/** Sort field: a built-in column or metadata.<field_name>.
 * Server-side validation in resolveSortColumn rejects unknown fields with 400.
 * Avoid .refine() here — ZodEffects breaks @hono/zod-openapi query param extraction. */
const sortFieldSchema = z
	.string()
	.max(100)
	.regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)?$/)
	.default('createdAt')

export const objectQuerySchema = z.object({
	type: objectTypeSchema.optional(),
	status: z.string().optional(),
	owner: z.string().uuid().optional(),
	sort: sortFieldSchema,
	order: z.enum(['asc', 'desc']).default('desc'),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
})

export const searchObjectsSchema = z.object({
	q: z.string().min(1),
	type: objectTypeSchema.optional(),
	status: z.string().optional(),
	sort: sortFieldSchema,
	order: z.enum(['asc', 'desc']).default('desc'),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	offset: z.coerce.number().int().min(0).default(0),
})

export const objectParamsSchema = z.object({
	id: z.string().uuid(),
})
