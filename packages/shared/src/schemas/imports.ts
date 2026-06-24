import { z } from 'zod'

export const importStatusSchema = z.enum([
	'uploading',
	'mapping',
	'importing',
	'completed',
	'failed',
])

export const importFileTypeSchema = z.enum(['csv', 'json'])

export const csvOptionsSchema = z.object({
	delimiter: z.enum([',', ';', '\t', '|']).default(','),
	encoding: z.enum(['utf-8', 'latin-1']).default('utf-8'),
})

export const columnMappingSchema = z.object({
	sourceColumn: z.string(),
	targetField: z.string(),
	transform: z.enum(['none', 'date', 'number', 'boolean']).default('none'),
	skip: z.boolean().default(false),
})

export const typeMappingSchema = z.object({
	objectType: z.string(),
	columns: z.array(columnMappingSchema),
	defaultStatus: z.string().optional(),
	// Optional list of dedup keys used by the bulk-import matching engine.
	// Each entry mirrors `columnMappingSchema.targetField` shape — either
	// `title` (top-level column) or `metadata.<field>` (JSONB path). The
	// import processor uses these to resolve matches before upsert; absent
	// or empty means the user opted into the "create all as new" hatch.
	dedupKeys: z.array(z.string()).optional(),
	// Explicit opt-in to the "create all as new" escape hatch — the only way
	// to confirm an import without any dedup key. Used by AC-U4 (frontend
	// gate + server backstop): when no dedup keys are set, this must be
	// true or both `/preview` and `/confirm` reject the request.
	createAllAsNew: z.boolean().optional(),
})

export const relationshipMappingSchema = z.object({
	sourceType: z.string(),
	relationshipType: z.string(),
	targetType: z.string(),
})

export const importMappingSchema = z.object({
	typeMappings: z.array(typeMappingSchema).min(1),
	relationships: z.array(relationshipMappingSchema).default([]),
	csvOptions: csvOptionsSchema.optional(),
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
export type TypeMapping = z.infer<typeof typeMappingSchema>
export type RelationshipMapping = z.infer<typeof relationshipMappingSchema>
export type ImportMapping = z.infer<typeof importMappingSchema>
export type CsvOptions = z.infer<typeof csvOptionsSchema>
