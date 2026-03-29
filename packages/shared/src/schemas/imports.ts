import { z } from 'zod'

export const importStatusSchema = z.enum([
	'uploading',
	'mapping',
	'importing',
	'completed',
	'failed',
])

export const importFileTypeSchema = z.enum(['csv', 'json'])

export const columnMappingSchema = z.object({
	sourceColumn: z.string(),
	targetField: z.string(),
	transform: z.enum(['none', 'date', 'number', 'boolean']).default('none'),
	skip: z.boolean().default(false),
})

export const importMappingSchema = z.object({
	objectType: z.union([
		z.string(),
		z.object({
			column: z.string(),
			typeMap: z.record(z.string(), z.string()),
		}),
	]),
	columns: z.array(columnMappingSchema),
	defaultStatus: z.string().optional(),
})

export const updateImportMappingSchema = z.object({
	mapping: importMappingSchema,
})

export const importQuerySchema = z.object({
	status: importStatusSchema.optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	offset: z.coerce.number().int().min(0).default(0),
})

export const importParamsSchema = z.object({
	id: z.string().uuid(),
})

export type ImportStatus = z.infer<typeof importStatusSchema>
export type ImportFileType = z.infer<typeof importFileTypeSchema>
export type ColumnMapping = z.infer<typeof columnMappingSchema>
export type ImportMapping = z.infer<typeof importMappingSchema>
