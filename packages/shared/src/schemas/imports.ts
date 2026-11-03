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

/**
 * The mapped field that identifies an existing object of the same type:
 * `title`, or `metadata.<field>`. The metadata field name follows the same
 * shape as `SAFE_METADATA_FIELD_NAME_RE`.
 */
export const IMPORT_MATCH_ON_RE = /^(title|metadata\.[a-zA-Z][a-zA-Z0-9_]*)$/

export const typeMappingSchema = z.object({
	objectType: z.string(),
	columns: z.array(columnMappingSchema),
	defaultStatus: z.string().optional(),
	/** When set, rows whose value for this field matches an existing object are not re-created. */
	matchOn: z.string().regex(IMPORT_MATCH_ON_RE).optional(),
})

/** What happens to a row that matches an existing object. Absent means `skip`. */
export const importOnMatchSchema = z.enum(['skip', 'update'])

export const relationshipMappingSchema = z.object({
	sourceType: z.string(),
	relationshipType: z.string(),
	targetType: z.string(),
})

export const importMappingSchema = z.object({
	typeMappings: z.array(typeMappingSchema).min(1),
	relationships: z.array(relationshipMappingSchema).default([]),
	csvOptions: csvOptionsSchema.optional(),
	onMatch: importOnMatchSchema.optional(),
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
export type ImportOnMatch = z.infer<typeof importOnMatchSchema>
