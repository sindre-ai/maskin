import type { Database } from '@ai-native/db'
import { events, imports, objects } from '@ai-native/db/schema'
import type { ImportMapping } from '@ai-native/shared'
import { parse } from 'csv-parse/sync'
import { eq } from 'drizzle-orm'
import { logger } from '../lib/logger'
import type { WorkspaceSettings } from '../lib/types'

export interface ParsedFile {
	columns: string[]
	rows: Record<string, string>[]
}

export interface ImportPreview {
	columns: string[]
	sampleRows: Record<string, string>[]
	totalRows: number
}

export interface ImportError {
	row: number
	column?: string
	message: string
	value?: string
}

export interface ImportResult {
	successCount: number
	errorCount: number
	errors: ImportError[]
}

// ── Parsing ──────────────────────────────────────────────────────────────

export function parseFile(buffer: Buffer, fileType: string): ParsedFile {
	if (fileType === 'csv') {
		return parseCsv(buffer)
	}
	if (fileType === 'json') {
		return parseJson(buffer)
	}
	throw new Error(`Unsupported file type: ${fileType}`)
}

function parseCsv(buffer: Buffer): ParsedFile {
	const records = parse(buffer, {
		columns: true,
		skip_empty_lines: true,
		trim: true,
		bom: true,
	}) as Record<string, string>[]

	if (records.length === 0) {
		throw new Error('CSV file contains no data rows')
	}

	const first = records[0]
	if (!first) throw new Error('CSV file contains no data rows')
	const columns = Object.keys(first)
	return { columns, rows: records }
}

function parseJson(buffer: Buffer): ParsedFile {
	const text = buffer.toString('utf-8')
	const data = JSON.parse(text)

	if (!Array.isArray(data)) {
		throw new Error('JSON file must contain an array of objects')
	}
	if (data.length === 0) {
		throw new Error('JSON file contains no data')
	}

	// Collect all unique keys across all objects
	const columnSet = new Set<string>()
	for (const row of data) {
		if (typeof row !== 'object' || row === null) {
			throw new Error('Each item in the JSON array must be an object')
		}
		for (const key of Object.keys(row)) {
			columnSet.add(key)
		}
	}

	const columns = [...columnSet]
	const rows = data.map((row: Record<string, unknown>) => {
		const normalized: Record<string, string> = {}
		for (const col of columns) {
			const val = row[col]
			normalized[col] = val == null ? '' : String(val)
		}
		return normalized
	})

	return { columns, rows }
}

// ── Auto-mapping ────────────────────────────────────────────────────────

const TRANSFORM_MAP: Record<string, 'none' | 'date' | 'number' | 'boolean'> = {
	number: 'number',
	date: 'date',
	boolean: 'boolean',
}

const RESERVED_ALIASES: Record<string, string[]> = {
	title: ['title', 'name', 'subject', 'heading'],
	content: ['content', 'description', 'notes', 'body', 'details', 'summary'],
	status: ['status', 'state', 'stage'],
	type: ['type', 'record_type', 'category', 'kind', 'object_type'],
	owner: ['owner', 'assigned_to', 'assignee', 'responsible'],
}

function normalize(s: string): string {
	return s
		.toLowerCase()
		.trim()
		.replace(/[\s-]+/g, '_')
}

function getColumnValues(rows: Record<string, string>[], col: string): string[] {
	return rows.map((r) => r[col] ?? '').filter((v) => v !== '')
}

export function generateMapping(
	columns: string[],
	sampleRows: Record<string, string>[],
	settings: WorkspaceSettings,
): ImportMapping {
	const mappedColumns: ImportMapping['columns'] = []
	const usedTargets = new Set<string>()

	// Detect type column and resolve object type
	let detectedObjectType: ImportMapping['objectType'] | undefined
	const validTypes = Object.keys(settings.statuses ?? {})

	// Phase 1: Match reserved fields
	for (const col of columns) {
		const norm = normalize(col)

		for (const [targetField, aliases] of Object.entries(RESERVED_ALIASES)) {
			if (aliases.includes(norm) && !usedTargets.has(targetField)) {
				if (targetField === 'type') {
					// Check if values match known types
					const sampleValues = getColumnValues(sampleRows, col).map((v) => normalize(v))
					const matchingTypes = sampleValues.filter((v) => validTypes.includes(v))
					if (matchingTypes.length > 0) {
						// Build type map from sample values
						const uniqueValues = [...new Set(getColumnValues(sampleRows, col))]
						const typeMap: Record<string, string> = {}
						for (const val of uniqueValues) {
							const normVal = normalize(val)
							if (validTypes.includes(normVal)) {
								typeMap[val] = normVal
							}
						}
						detectedObjectType = { column: col, typeMap }
						mappedColumns.push({
							sourceColumn: col,
							targetField: 'type',
							transform: 'none' as const,
							skip: false,
						})
						usedTargets.add('type')
						break
					}
				} else {
					mappedColumns.push({
						sourceColumn: col,
						targetField,
						transform: 'none' as const,
						skip: false,
					})
					usedTargets.add(targetField)
					break
				}
			}
		}
	}

	// Phase 2: Match remaining columns against field definitions
	const fieldDefs = settings.field_definitions ?? {}
	// Collect all field definitions across all types
	const allFields = new Map<string, { type: string; values?: string[] }>()
	for (const typeDefs of Object.values(fieldDefs)) {
		if (Array.isArray(typeDefs)) {
			for (const fd of typeDefs) {
				if (!allFields.has(fd.name)) {
					allFields.set(fd.name, { type: fd.type, values: fd.values })
				}
			}
		}
	}

	const mappedSourceColumns = new Set(mappedColumns.map((m) => m.sourceColumn))

	for (const col of columns) {
		if (mappedSourceColumns.has(col)) continue

		const norm = normalize(col)
		let matched = false

		// Exact name match against field definitions
		for (const [fieldName, fieldInfo] of allFields) {
			if (normalize(fieldName) === norm) {
				const transform = TRANSFORM_MAP[fieldInfo.type] ?? 'none'
				mappedColumns.push({
					sourceColumn: col,
					targetField: `metadata.${fieldName}`,
					transform,
					skip: false,
				})
				matched = true
				break
			}
		}

		if (!matched) {
			// Check if sample values match an enum field
			for (const [fieldName, fieldInfo] of allFields) {
				if (fieldInfo.type === 'enum' && fieldInfo.values && fieldInfo.values.length > 0) {
					const sampleValues = getColumnValues(sampleRows, col).map((v) => v.toLowerCase())
					const enumValues = fieldInfo.values.map((v) => v.toLowerCase())
					const overlap = sampleValues.filter((v) => enumValues.includes(v))
					if (overlap.length > 0 && overlap.length >= sampleValues.length * 0.5) {
						mappedColumns.push({
							sourceColumn: col,
							targetField: `metadata.${fieldName}`,
							transform: 'none' as const,
							skip: false,
						})
						matched = true
						break
					}
				}
			}
		}

		if (!matched) {
			// Substring match against field definitions
			for (const [fieldName] of allFields) {
				const normField = normalize(fieldName)
				if (norm.includes(normField) || normField.includes(norm)) {
					mappedColumns.push({
						sourceColumn: col,
						targetField: `metadata.${fieldName}`,
						transform: 'none' as const,
						skip: false,
					})
					matched = true
					break
				}
			}
		}

		if (!matched) {
			// Unmatched — mark as metadata with the column name, skip by default
			mappedColumns.push({
				sourceColumn: col,
				targetField: `metadata.${norm}`,
				transform: 'none' as const,
				skip: true,
			})
		}
	}

	// Determine object type if not detected from a column
	if (!detectedObjectType) {
		// Default to first valid type
		detectedObjectType = validTypes[0] ?? 'insight'
	}

	// Determine default status
	const staticType = typeof detectedObjectType === 'string' ? detectedObjectType : undefined
	const defaultStatus = staticType ? (settings.statuses?.[staticType]?.[0] ?? undefined) : undefined

	return {
		objectType: detectedObjectType,
		columns: mappedColumns,
		defaultStatus,
	}
}

// ── Import Execution ────────────────────────────────────────────────────

const BATCH_SIZE = 50

interface MappedRow {
	type: string
	title?: string
	content?: string
	status: string
	metadata: Record<string, unknown>
	owner?: string
}

function applyTransform(value: string, transform: string): string | number | boolean {
	if (transform === 'number') {
		const num = Number(value)
		return Number.isNaN(num) ? value : num
	}
	if (transform === 'boolean') {
		const lower = value.toLowerCase()
		return lower === 'true' || lower === '1' || lower === 'yes'
	}
	// 'date' and 'none' keep as string
	return value
}

function mapRow(
	row: Record<string, string>,
	mapping: ImportMapping,
	settings: WorkspaceSettings,
): MappedRow {
	let type: string
	if (typeof mapping.objectType === 'string') {
		type = mapping.objectType
	} else {
		const rawType = row[mapping.objectType.column] ?? ''
		type = mapping.objectType.typeMap[rawType] ?? rawType
	}

	let title: string | undefined
	let content: string | undefined
	let status: string | undefined
	let owner: string | undefined
	const metadata: Record<string, unknown> = {}

	for (const col of mapping.columns) {
		if (col.skip) continue
		const value = row[col.sourceColumn]
		if (value === undefined || value === '') continue

		if (col.targetField === 'title') {
			title = value
		} else if (col.targetField === 'content') {
			content = value
		} else if (col.targetField === 'status') {
			status = value
		} else if (col.targetField === 'owner') {
			owner = value
		} else if (col.targetField === 'type') {
			// Already handled via objectType
		} else if (col.targetField.startsWith('metadata.')) {
			const fieldName = col.targetField.slice('metadata.'.length)
			metadata[fieldName] = applyTransform(value, col.transform)
		}
	}

	// Fall back to default status
	if (!status) {
		status = mapping.defaultStatus ?? settings.statuses?.[type]?.[0] ?? 'new'
	}

	return { type, title, content, status, metadata, owner }
}

export async function executeImport(
	importId: string,
	rows: Record<string, string>[],
	mapping: ImportMapping,
	workspaceId: string,
	actorId: string,
	settings: WorkspaceSettings,
	db: Database,
): Promise<ImportResult> {
	let successCount = 0
	let errorCount = 0
	const errors: ImportError[] = []

	for (let i = 0; i < rows.length; i += BATCH_SIZE) {
		const batch = rows.slice(i, i + BATCH_SIZE)
		const batchErrors: ImportError[] = []

		// Phase 1: Validate and map rows before the transaction
		const validRows: { rowIndex: number; mapped: MappedRow }[] = []
		for (let j = 0; j < batch.length; j++) {
			const rowIndex = i + j + 1 // 1-based
			const row = batch[j]
			if (!row) continue

			const mapped = mapRow(row, mapping, settings)
			if (!mapped.title && !mapped.content) {
				batchErrors.push({
					row: rowIndex,
					message: 'Row has no title or content',
				})
				continue
			}
			validRows.push({ rowIndex, mapped })
		}

		// Phase 2: Bulk insert all valid rows in a single transaction
		if (validRows.length > 0) {
			try {
				await db.transaction(async (tx) => {
					const createdObjects = await tx
						.insert(objects)
						.values(
							validRows.map(({ mapped }) => ({
								workspaceId,
								type: mapped.type,
								title: mapped.title,
								content: mapped.content,
								status: mapped.status,
								metadata:
									Object.keys(mapped.metadata).length > 0 ? mapped.metadata : undefined,
								owner: mapped.owner,
								createdBy: actorId,
							})),
						)
						.returning()

					if (createdObjects.length > 0) {
						await tx.insert(events).values(
							createdObjects.map((obj) => ({
								workspaceId,
								actorId,
								action: 'created' as const,
								entityType: obj.type,
								entityId: obj.id,
								data: { id: obj.id, type: obj.type, title: obj.title },
							})),
						)
					}
				})
				successCount += validRows.length
			} catch (err) {
				// Entire batch transaction failed — all valid rows in this batch are errors
				for (const { rowIndex } of validRows) {
					batchErrors.push({
						row: rowIndex,
						message: `Batch failed: ${err instanceof Error ? err.message : String(err)}`,
					})
				}
			}
		}

		errorCount += batchErrors.length
		errors.push(...batchErrors)

		// Update progress on the import row
		await db
			.update(imports)
			.set({
				processedRows: Math.min(i + BATCH_SIZE, rows.length),
				successCount,
				errorCount,
				errors: errors.length > 0 ? errors : undefined,
				updatedAt: new Date(),
			})
			.where(eq(imports.id, importId))
	}

	logger.info('Import execution completed', {
		importId,
		successCount,
		errorCount,
		totalRows: rows.length,
	})

	return { successCount, errorCount, errors }
}
