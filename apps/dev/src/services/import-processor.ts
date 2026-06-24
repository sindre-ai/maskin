import type { Database } from '@maskin/db'
import {
	events,
	type NewImportAuditRow,
	importAuditRows,
	imports,
	objects,
	relationships,
} from '@maskin/db/schema'
import type { CsvOptions, ImportMapping, TypeMapping } from '@maskin/shared'
import { parse } from 'csv-parse/sync'
import { type SQL, and, eq, isNotNull, ne, or, sql } from 'drizzle-orm'
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
	/** Number of objects created (can exceed totalRows when multiple type mappings produce objects per row) */
	successCount: number
	/** Number of row-level errors during object creation */
	errorCount: number
	/** Number of existing objects updated by dedup-key matching */
	updatedCount: number
	/** Number of rows resolved to an existing object with no changes (skipped) */
	skippedCount: number
	/** Number of relationships created in Pass 2 */
	relationshipCount: number
	/** Number of relationship-level errors */
	relationshipErrorCount: number
	errors: ImportError[]
}

// ── Parsing ──────────────────────────────────────────────────────────────

export function parseFile(buffer: Buffer, fileType: string, csvOptions?: CsvOptions): ParsedFile {
	if (fileType === 'csv') {
		return parseCsv(buffer, csvOptions)
	}
	if (fileType === 'json') {
		return parseJson(buffer)
	}
	throw new Error(`Unsupported file type: ${fileType}`)
}

/**
 * Decode a buffer to string, handling different encodings.
 * Falls back to Latin-1 if UTF-8 decoding produces replacement characters.
 */
function decodeBuffer(buffer: Buffer, encoding?: string): string {
	if (encoding === 'latin-1') {
		return new TextDecoder('latin1').decode(buffer)
	}

	// Default: try UTF-8
	const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer)

	// If no encoding was specified and UTF-8 produced replacement chars, try Latin-1
	if (!encoding && text.includes('\uFFFD')) {
		return new TextDecoder('latin1').decode(buffer)
	}

	return text
}

/**
 * Auto-detect the most likely delimiter by counting candidate characters
 * across the first few non-empty lines. Respects quoted fields.
 */
function detectDelimiter(text: string): ',' | ';' | '\t' | '|' {
	const candidates = [',', ';', '\t', '|'] as const
	const lines = text
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0)
		.slice(0, 10)

	if (lines.length === 0) return ','

	let bestDelimiter: ',' | ';' | '\t' | '|' = ','
	let bestScore = -1

	for (const delim of candidates) {
		const counts = lines.map((line) => {
			let count = 0
			let inQuotes = false
			for (const ch of line) {
				if (ch === '"') inQuotes = !inQuotes
				else if (ch === delim && !inQuotes) count++
			}
			return count
		})

		// Must have at least 1 delimiter on every sampled line
		const minCount = Math.min(...counts)
		if (minCount === 0) continue

		// Score: consistent counts (low variance) and more fields = better
		const avg = counts.reduce((a, b) => a + b, 0) / counts.length
		const variance = counts.reduce((sum, c) => sum + (c - avg) ** 2, 0) / counts.length
		const score = avg * lines.length - variance

		if (score > bestScore) {
			bestScore = score
			bestDelimiter = delim
		}
	}

	return bestDelimiter
}

/**
 * Auto-detect CSV options (delimiter and encoding) from a raw file buffer.
 */
export function detectCsvOptions(buffer: Buffer): CsvOptions {
	const utf8Text = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
	const hasReplacementChars = utf8Text.includes('\uFFFD')
	const encoding = hasReplacementChars ? ('latin-1' as const) : ('utf-8' as const)

	const text = hasReplacementChars ? new TextDecoder('latin1').decode(buffer) : utf8Text
	const cleanText = text.replace(/^\uFEFF/, '')
	const delimiter = detectDelimiter(cleanText)

	return { delimiter, encoding }
}

/**
 * Detect the 1-based line number of the actual header row in a CSV.
 * Some exports (e.g. LinkedIn Connections) prepend notes/metadata rows before
 * the real column headers. We find the header by looking for the first line
 * that contains at least 2 delimiter-separated values — preamble rows are typically
 * single-value lines or key/value pairs.
 */
function detectHeaderLine(text: string, delimiter: string): number {
	const lines = text.split(/\r?\n/)
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]?.trim()
		if (!line) continue
		// Count delimiter occurrences outside quotes
		let count = 0
		let inQuotes = false
		for (const ch of line) {
			if (ch === '"') inQuotes = !inQuotes
			else if (ch === delimiter && !inQuotes) count++
		}
		// A row with ≥1 delimiter yields ≥2 fields — likely the header
		if (count >= 1) {
			return i + 1 // csv-parse from_line is 1-based
		}
	}
	return 1 // fallback: first line
}

function parseCsv(buffer: Buffer, options?: CsvOptions): ParsedFile {
	const text = decodeBuffer(buffer, options?.encoding).replace(/^\uFEFF/, '') // strip BOM
	const delimiter = options?.delimiter || detectDelimiter(text)
	const headerLine = detectHeaderLine(text, delimiter)

	const records = parse(text, {
		columns: true,
		skip_empty_lines: true,
		trim: true,
		bom: true,
		delimiter,
		from_line: headerLine,
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
	driver: ['owner', 'assigned_to', 'assignee', 'responsible'],
}

function normalize(s: string): string {
	return s
		.toLowerCase()
		.trim()
		.replace(/[\s-]+/g, '_')
}

export function generateMapping(
	columns: string[],
	sampleRows: Record<string, string>[],
	settings: WorkspaceSettings,
	csvOptions?: CsvOptions,
): ImportMapping {
	const mappedColumns: TypeMapping['columns'] = []
	const usedTargets = new Set<string>()

	const validTypes = Object.keys(settings.statuses ?? {})

	// Phase 1: Match reserved fields
	for (const col of columns) {
		const norm = normalize(col)

		for (const [targetField, aliases] of Object.entries(RESERVED_ALIASES)) {
			if (aliases.includes(norm) && !usedTargets.has(targetField)) {
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
					const sampleValues = sampleRows.map((r) => (r[col] ?? '').toLowerCase()).filter(Boolean)
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

	// Default to first valid type
	const objectType = validTypes[0] ?? 'insight'
	const defaultStatus = settings.statuses?.[objectType]?.[0] ?? undefined

	return {
		typeMappings: [
			{
				objectType,
				columns: mappedColumns,
				defaultStatus,
			},
		],
		relationships: [],
		...(csvOptions ? { csvOptions } : {}),
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
	driver?: string
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

export function mapRowForType(
	row: Record<string, string>,
	typeMapping: TypeMapping,
	settings: WorkspaceSettings,
): MappedRow | null {
	const type = typeMapping.objectType

	const titleParts: string[] = []
	const contentParts: string[] = []
	let status: string | undefined
	let driver: string | undefined
	const metadata: Record<string, unknown> = {}
	let hasValue = false

	for (const col of typeMapping.columns) {
		if (col.skip) continue
		const value = row[col.sourceColumn]
		if (value === undefined || value === '') continue

		hasValue = true
		if (col.targetField === 'title') {
			titleParts.push(value)
		} else if (col.targetField === 'content') {
			contentParts.push(value)
		} else if (col.targetField === 'status') {
			status = value
		} else if (col.targetField === 'driver') {
			driver = value
		} else if (col.targetField.startsWith('metadata.')) {
			const fieldName = col.targetField.slice('metadata.'.length)
			const transformed = applyTransform(value, col.transform)
			// Only concatenate when both values are strings — transforms can produce
			// numbers/booleans where concatenation doesn't make sense (last value wins).
			if (
				metadata[fieldName] !== undefined &&
				typeof metadata[fieldName] === 'string' &&
				typeof transformed === 'string'
			) {
				metadata[fieldName] = `${metadata[fieldName]} ${transformed}`
			} else {
				metadata[fieldName] = transformed
			}
		}
	}

	// Skip this type for this row if no non-skipped columns had values
	if (!hasValue) return null
	const title = titleParts.length > 0 ? titleParts.join(' ') : undefined
	const content = contentParts.length > 0 ? contentParts.join(' ') : undefined
	// Must have at least a title or content
	if (!title && !content) return null

	// Fall back to default status
	if (!status) {
		status = typeMapping.defaultStatus ?? settings.statuses?.[type]?.[0] ?? 'new'
	}

	return { type, title, content, status, metadata, driver }
}

// ── Dedup matching engine ────────────────────────────────────────────────
//
// When a `typeMapping.dedupKeys` array is set, the per-batch transaction
// resolves each input row to an outcome before any write happens:
//   - `created` — no existing object matched on all keys, INSERT a new one
//   - `updated` — existing object matched and at least one mapped column
//                 differs; UPDATE only the changed columns (columns the
//                 CSV omits stay untouched)
//   - `skipped` — existing object matched and every mapped column already
//                 equals the existing value (idempotent re-run)
// The full classify + write happens in one transaction per batch so AC-T7
// (parallel imports with overlapping keys must not double-create) is
// surfaced by the integration test against real Postgres.

type DedupKey = { kind: 'title' } | { kind: 'metadata'; field: string }

const METADATA_FIELD_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** Parse `dedupKeys` strings into validated key descriptors. Throws on a malformed entry so the batch surfaces a clear error rather than silently matching the wrong field. */
function parseDedupKeys(keys: readonly string[]): DedupKey[] {
	const out: DedupKey[] = []
	for (const key of keys) {
		if (key === 'title') {
			out.push({ kind: 'title' })
			continue
		}
		if (key.startsWith('metadata.')) {
			const field = key.slice('metadata.'.length)
			if (!METADATA_FIELD_RE.test(field)) {
				throw new Error(
					`Invalid dedup key '${key}': metadata field must match ${METADATA_FIELD_RE}`,
				)
			}
			out.push({ kind: 'metadata', field })
			continue
		}
		throw new Error(
			`Invalid dedup key '${key}': must be 'title' or 'metadata.<field>' (e.g. 'metadata.email')`,
		)
	}
	return out
}

interface ExistingRow {
	id: string
	title: string | null
	content: string | null
	status: string
	driver: string | null
	metadata: Record<string, unknown> | null
}

function stringifyMetadataValue(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined
	if (typeof value === 'string') return value
	return String(value)
}

/** Extract the dedup-key tuple from a mapped CSV row. Returns `null` if any key has an empty / undefined value — those rows route to "create" per AC-T3. */
function getMappedDedupTuple(mapped: MappedRow, keys: DedupKey[]): string[] | null {
	const out: string[] = []
	for (const key of keys) {
		const value =
			key.kind === 'title' ? mapped.title : stringifyMetadataValue(mapped.metadata[key.field])
		if (value === undefined || value === '') return null
		out.push(value)
	}
	return out
}

/** Extract the dedup-key tuple from an existing object. Returns `null` if any stored value is NULL/empty — those rows never match (AC-T3, "empty ≠ empty"). */
function getExistingDedupTuple(existing: ExistingRow, keys: DedupKey[]): string[] | null {
	const out: string[] = []
	for (const key of keys) {
		const value =
			key.kind === 'title' ? existing.title : stringifyMetadataValue(existing.metadata?.[key.field])
		if (value === undefined || value === null || value === '') return null
		out.push(value)
	}
	return out
}

/** Build a single SQL clause matching one CSV row's dedup-key tuple against the `objects` row. `IS NOT NULL AND <> ''` excludes NULL/empty stored values (AC-T3). */
function buildRowMatchClause(keys: DedupKey[], tuple: string[]): SQL {
	const parts: SQL[] = []
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i]
		const value = tuple[i]
		if (key === undefined || value === undefined) continue
		if (key.kind === 'title') {
			const titleClause = and(
				isNotNull(objects.title),
				ne(objects.title, ''),
				eq(objects.title, value),
			)
			if (titleClause !== undefined) parts.push(titleClause)
		} else {
			parts.push(
				sql`${objects.metadata}->>${key.field} IS NOT NULL AND ${objects.metadata}->>${key.field} <> '' AND ${objects.metadata}->>${key.field} = ${value}`,
			)
		}
	}
	const composed = and(...parts)
	if (composed === undefined) {
		throw new Error('buildRowMatchClause produced an empty clause — dedupKeys must be non-empty')
	}
	return composed
}

interface DiffResult {
	changedColumns: string[]
	oldValues: Record<string, unknown>
	newValues: Record<string, unknown>
	setPayload: Partial<{
		title: string | null
		content: string | null
		status: string
		driver: string | null
		metadata: Record<string, unknown> | null
	}>
}

/** Compute the diff between a mapped CSV row and an existing object. Only mapped (non-skip) target fields are compared — columns the CSV omits stay untouched (AC-T4). The setPayload is the minimal patch to send to UPDATE objects SET. */
function diffMappedRow(
	mapped: MappedRow,
	existing: ExistingRow,
	typeMapping: TypeMapping,
): DiffResult {
	const changedColumns: string[] = []
	const oldValues: Record<string, unknown> = {}
	const newValues: Record<string, unknown> = {}
	const setPayload: DiffResult['setPayload'] = {}

	const csvProvidesTitle = mapped.title !== undefined
	const csvProvidesContent = mapped.content !== undefined
	const csvProvidesStatus = typeMapping.columns.some((c) => !c.skip && c.targetField === 'status')
	const csvProvidesDriver = mapped.driver !== undefined

	if (csvProvidesTitle && (mapped.title ?? null) !== (existing.title ?? null)) {
		changedColumns.push('title')
		oldValues.title = existing.title
		newValues.title = mapped.title
		setPayload.title = mapped.title ?? null
	}
	if (csvProvidesContent && (mapped.content ?? null) !== (existing.content ?? null)) {
		changedColumns.push('content')
		oldValues.content = existing.content
		newValues.content = mapped.content
		setPayload.content = mapped.content ?? null
	}
	if (csvProvidesStatus && mapped.status !== existing.status) {
		changedColumns.push('status')
		oldValues.status = existing.status
		newValues.status = mapped.status
		setPayload.status = mapped.status
	}
	if (csvProvidesDriver && (mapped.driver ?? null) !== (existing.driver ?? null)) {
		changedColumns.push('driver')
		oldValues.driver = existing.driver
		newValues.driver = mapped.driver
		setPayload.driver = mapped.driver ?? null
	}

	// Metadata: compare each CSV-provided metadata.<field> against the existing
	// row. The UPDATE merges changed fields into existing metadata so CSV-omitted
	// metadata columns stay at their stored value (AC-T4).
	const mergedMetadata: Record<string, unknown> = { ...(existing.metadata ?? {}) }
	let metadataChanged = false
	for (const [field, value] of Object.entries(mapped.metadata)) {
		const existingValue = existing.metadata?.[field]
		const same =
			existingValue === value ||
			(existingValue === undefined && value === undefined) ||
			(existingValue === null && value === null) ||
			(typeof existingValue !== 'object' &&
				typeof value !== 'object' &&
				String(existingValue) === String(value))
		if (!same) {
			changedColumns.push(`metadata.${field}`)
			oldValues[`metadata.${field}`] = existingValue ?? null
			newValues[`metadata.${field}`] = value
			mergedMetadata[field] = value
			metadataChanged = true
		}
	}
	if (metadataChanged) {
		setPayload.metadata = mergedMetadata
	}

	return { changedColumns, oldValues, newValues, setPayload }
}

interface ValidRow {
	rowIndex: number
	mapped: MappedRow
}

interface ClassifiedBuckets {
	creates: ValidRow[]
	updates: { row: ValidRow; existing: ExistingRow; diff: DiffResult }[]
	skips: { row: ValidRow; existing: ExistingRow }[]
}

/** Classify a batch of valid rows for one type mapping into create/update/skip buckets. Multi-match resolves to the lowest object_id deterministically. */
function classifyRows(
	validRows: ValidRow[],
	dedupKeys: DedupKey[],
	existingByTuple: Map<string, ExistingRow>,
	typeMapping: TypeMapping,
): ClassifiedBuckets {
	const creates: ValidRow[] = []
	const updates: ClassifiedBuckets['updates'] = []
	const skips: ClassifiedBuckets['skips'] = []
	const usedExistingIds = new Set<string>()

	for (const row of validRows) {
		if (dedupKeys.length === 0) {
			creates.push(row)
			continue
		}
		const tuple = getMappedDedupTuple(row.mapped, dedupKeys)
		if (tuple === null) {
			creates.push(row)
			continue
		}
		const tupleKey = tuple.join('\u0000')
		const existing = existingByTuple.get(tupleKey)
		if (!existing) {
			creates.push(row)
			continue
		}
		// Same existing object should not be updated/skipped by two CSV rows in
		// the same batch — second row falls through to create-new so AC-T3's
		// "every key clause must match the same stored row" semantics survive a
		// batch with two identical dedup tuples.
		if (usedExistingIds.has(existing.id)) {
			creates.push(row)
			continue
		}
		usedExistingIds.add(existing.id)
		const diff = diffMappedRow(row.mapped, existing, typeMapping)
		if (diff.changedColumns.length === 0) {
			skips.push({ row, existing })
		} else {
			updates.push({ row, existing, diff })
		}
	}

	return { creates, updates, skips }
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
	let updatedCount = 0
	let skippedCount = 0
	let relationshipCount = 0
	let relationshipErrorCount = 0
	const errors: ImportError[] = []

	const relDefs = mapping.relationships ?? []
	// Track (rowIndex, objectType) → object ID for relationship pass. Populated
	// for created AND updated/skipped outcomes — a relationship should bind to
	// the resolved object regardless of whether this import row created it or
	// matched an existing one.
	const rowTypeToObjectId = new Map<string, string>()

	// ── Pass 1: Resolve + write per batch ───────────────────────────────
	for (let i = 0; i < rows.length; i += BATCH_SIZE) {
		const batch = rows.slice(i, i + BATCH_SIZE)
		const batchErrors: ImportError[] = []

		// Build per-typeMapping context for this batch. Index preserved so we
		// can restore row-major ordering (rowIndex first, typeMapping second)
		// when batching INSERTs across typeMappings.
		const perType = mapping.typeMappings.map((typeMapping, typeMappingIdx) => {
			const dedupKeys = parseDedupKeys(typeMapping.dedupKeys ?? [])
			const validRows: ValidRow[] = []
			for (let j = 0; j < batch.length; j++) {
				const rowIndex = i + j
				const row = batch[j]
				if (!row) continue
				const mapped = mapRowForType(row, typeMapping, settings)
				if (mapped) validRows.push({ rowIndex, mapped })
			}
			return { typeMapping, typeMappingIdx, dedupKeys, validRows }
		})

		const totalValidRows = perType.reduce((sum, p) => sum + p.validRows.length, 0)
		const anyDedup = perType.some((p) => p.dedupKeys.length > 0)
		const allValidRowIndexes = perType.flatMap((p) => p.validRows.map((r) => r.rowIndex))

		if (totalValidRows > 0) {
			try {
				const batchResult = await db.transaction(async (tx) => {
					// Serialize per-workspace import batches so two parallel
					// imports with overlapping dedup tuples cannot both
					// match-select before either writes — the documented
					// architecture fallback for AC-T7. The lock auto-releases
					// at transaction commit/rollback.
					if (anyDedup) {
						await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`)
					}

					const allCreates: {
						typeMapping: TypeMapping
						typeMappingIdx: number
						row: ValidRow
					}[] = []
					const allUpdates: {
						typeMapping: TypeMapping
						typeMappingIdx: number
						row: ValidRow
						existing: ExistingRow
						diff: DiffResult
					}[] = []
					const allSkips: {
						typeMapping: TypeMapping
						typeMappingIdx: number
						row: ValidRow
						existing: ExistingRow
					}[] = []

					// 1. For each typeMapping: match-select (when dedup is configured)
					//    + classify into create/update/skip buckets. Match-select is
					//    type-scoped so it has to be per-typeMapping; INSERT can be
					//    batched across typeMappings (objects is one table).
					for (const { typeMapping, typeMappingIdx, dedupKeys, validRows } of perType) {
						if (validRows.length === 0) continue

						const existingByTuple = new Map<string, ExistingRow>()
						if (dedupKeys.length > 0) {
							const lookupTuples: string[][] = []
							for (const row of validRows) {
								const tuple = getMappedDedupTuple(row.mapped, dedupKeys)
								if (tuple !== null) lookupTuples.push(tuple)
							}
							if (lookupTuples.length > 0) {
								const rowClauses: SQL[] = []
								for (const tuple of lookupTuples) {
									rowClauses.push(buildRowMatchClause(dedupKeys, tuple))
								}
								const matched = await tx
									.select({
										id: objects.id,
										title: objects.title,
										content: objects.content,
										status: objects.status,
										driver: objects.driver,
										metadata: objects.metadata,
									})
									.from(objects)
									.where(
										and(
											eq(objects.workspaceId, workspaceId),
											eq(objects.type, typeMapping.objectType),
											or(...rowClauses),
										),
									)

								const grouped = new Map<string, ExistingRow[]>()
								for (const row of matched) {
									const ex: ExistingRow = {
										id: row.id,
										title: row.title,
										content: row.content,
										status: row.status,
										driver: row.driver,
										metadata: (row.metadata ?? null) as Record<string, unknown> | null,
									}
									const tuple = getExistingDedupTuple(ex, dedupKeys)
									if (tuple === null) continue
									const tupleKey = tuple.join('\u0000')
									const list = grouped.get(tupleKey) ?? []
									list.push(ex)
									grouped.set(tupleKey, list)
								}
								for (const [tupleKey, list] of grouped) {
									list.sort((a, b) => a.id.localeCompare(b.id))
									const head = list[0]
									if (head) existingByTuple.set(tupleKey, head)
								}
							}
						}

						const { creates, updates, skips } = classifyRows(
							validRows,
							dedupKeys,
							existingByTuple,
							typeMapping,
						)
						for (const row of creates) allCreates.push({ typeMapping, typeMappingIdx, row })
						for (const u of updates) allUpdates.push({ typeMapping, typeMappingIdx, ...u })
						for (const s of skips) allSkips.push({ typeMapping, typeMappingIdx, ...s })
					}

					// Restore row-major ordering across typeMappings so paired
					// arrays (allCreates ↔ createdRows) line up with the row-major
					// shape the executor uses elsewhere.
					const sortByRowThenType = <T extends { row: ValidRow; typeMappingIdx: number }>(
						a: T,
						b: T,
					) => a.row.rowIndex - b.row.rowIndex || a.typeMappingIdx - b.typeMappingIdx
					allCreates.sort(sortByRowThenType)
					allUpdates.sort(sortByRowThenType)
					allSkips.sort(sortByRowThenType)

					// 2. INSERT all creates in one batch (across typeMappings).
					let createdRows: { id: string; type: string; title: string | null }[] = []
					if (allCreates.length > 0) {
						createdRows = await tx
							.insert(objects)
							.values(
								allCreates.map(({ row }) => ({
									workspaceId,
									type: row.mapped.type,
									title: row.mapped.title,
									content: row.mapped.content,
									status: row.mapped.status,
									metadata:
										Object.keys(row.mapped.metadata).length > 0 ? row.mapped.metadata : undefined,
									driver: row.mapped.driver,
									createdBy: actorId,
								})),
							)
							.returning({
								id: objects.id,
								type: objects.type,
								title: objects.title,
							})

						await tx.insert(events).values(
							createdRows.map((obj) => ({
								workspaceId,
								actorId,
								action: 'created' as const,
								entityType: obj.type,
								entityId: obj.id,
								data: { id: obj.id, type: obj.type, title: obj.title },
							})),
						)
					}

					// 3. UPDATE matched objects — one statement per row, SET payload
					//    differs per row (changed-cols-only, AC-T4).
					for (const { typeMapping, existing, diff } of allUpdates) {
						await tx
							.update(objects)
							.set({ ...diff.setPayload, updatedAt: new Date() })
							.where(eq(objects.id, existing.id))

						await tx.insert(events).values({
							workspaceId,
							actorId,
							action: 'updated',
							entityType: typeMapping.objectType,
							entityId: existing.id,
							data: {
								id: existing.id,
								changedColumns: diff.changedColumns,
								importId,
							},
						})
					}

					// 4. INSERT audit rows for every dedup-configured outcome in
					//    this batch. Rows under typeMappings without dedupKeys are
					//    deliberately not audited — the "create all as new" hatch
					//    keeps the audit table empty.
					if (anyDedup) {
						const auditRows: NewImportAuditRow[] = []
						for (let k = 0; k < allCreates.length; k++) {
							const c = allCreates[k]
							const created = createdRows[k]
							if (!c || !created) continue
							if (c.typeMapping.dedupKeys?.length) {
								auditRows.push({
									importId,
									rowIndex: c.row.rowIndex,
									objectId: created.id,
									action: 'created',
									changedColumns: [],
									oldValues: {},
									newValues: {},
								})
							}
						}
						for (const { typeMapping, row, existing, diff } of allUpdates) {
							if (!typeMapping.dedupKeys?.length) continue
							auditRows.push({
								importId,
								rowIndex: row.rowIndex,
								objectId: existing.id,
								action: 'updated',
								changedColumns: diff.changedColumns,
								oldValues: diff.oldValues,
								newValues: diff.newValues,
							})
						}
						for (const { typeMapping, row, existing } of allSkips) {
							if (!typeMapping.dedupKeys?.length) continue
							auditRows.push({
								importId,
								rowIndex: row.rowIndex,
								objectId: existing.id,
								action: 'skipped',
								changedColumns: [],
								oldValues: {},
								newValues: {},
							})
						}
						if (auditRows.length > 0) {
							await tx.insert(importAuditRows).values(auditRows)
						}
					}

					return { allCreates, createdRows, allUpdates, allSkips }
				})

				// Bind every resolved row → object id so Pass 2 can build
				// relationships against created AND matched objects.
				for (let k = 0; k < batchResult.allCreates.length; k++) {
					const create = batchResult.allCreates[k]
					const created = batchResult.createdRows[k]
					if (!create || !created) continue
					rowTypeToObjectId.set(`${create.row.rowIndex}::${created.type}`, created.id)
				}
				for (const upd of batchResult.allUpdates) {
					rowTypeToObjectId.set(
						`${upd.row.rowIndex}::${upd.typeMapping.objectType}`,
						upd.existing.id,
					)
				}
				for (const sk of batchResult.allSkips) {
					rowTypeToObjectId.set(`${sk.row.rowIndex}::${sk.typeMapping.objectType}`, sk.existing.id)
				}

				successCount += batchResult.createdRows.length
				updatedCount += batchResult.allUpdates.length
				skippedCount += batchResult.allSkips.length
			} catch (err) {
				const uniqueRows = [...new Set(allValidRowIndexes)]
				for (const rowIndex of uniqueRows) {
					batchErrors.push({
						row: rowIndex + 1,
						message: `Batch failed: ${err instanceof Error ? err.message : String(err)}`,
					})
				}
			}
		}

		errorCount += batchErrors.length
		errors.push(...batchErrors)

		await db
			.update(imports)
			.set({
				processedRows: Math.min(i + BATCH_SIZE, rows.length),
				successCount,
				errorCount,
				updatedCount,
				skippedCount,
				errors: errors.length > 0 ? errors : undefined,
				updatedAt: new Date(),
			})
			.where(eq(imports.id, importId))
	}

	// ── Pass 2: Create relationships ────────────────────────────────────
	if (relDefs.length > 0 && rowTypeToObjectId.size > 0) {
		const relBatch: {
			sourceType: string
			sourceId: string
			targetType: string
			targetId: string
			type: string
		}[] = []
		const seen = new Set<string>()

		for (let i = 0; i < rows.length; i++) {
			for (const relDef of relDefs) {
				const sourceKey = `${i}::${relDef.sourceType}`
				const targetKey = `${i}::${relDef.targetType}`
				const sourceId = rowTypeToObjectId.get(sourceKey)
				const targetId = rowTypeToObjectId.get(targetKey)
				if (!sourceId || !targetId || sourceId === targetId) continue

				const dedupKey = `${sourceId}::${targetId}::${relDef.relationshipType}`
				if (seen.has(dedupKey)) continue
				seen.add(dedupKey)

				relBatch.push({
					sourceType: relDef.sourceType,
					sourceId,
					targetType: relDef.targetType,
					targetId,
					type: relDef.relationshipType,
				})
			}
		}

		// Insert relationships in batches
		for (let i = 0; i < relBatch.length; i += BATCH_SIZE) {
			const batch = relBatch.slice(i, i + BATCH_SIZE)
			try {
				const created = await db
					.insert(relationships)
					.values(
						batch.map((r) => ({
							sourceType: r.sourceType,
							sourceId: r.sourceId,
							targetType: r.targetType,
							targetId: r.targetId,
							type: r.type,
							createdBy: actorId,
						})),
					)
					.onConflictDoNothing()
					.returning()

				relationshipCount += created.length

				// Log relationship events
				if (created.length > 0) {
					await db.insert(events).values(
						created.map((rel) => ({
							workspaceId,
							actorId,
							action: 'created' as const,
							entityType: 'relationship',
							entityId: rel.id,
							data: rel,
						})),
					)
				}
			} catch (err) {
				const message = `Relationship batch failed: ${err instanceof Error ? err.message : String(err)}`
				logger.error(message, { importId })
				relationshipErrorCount += batch.length
				errors.push({ row: -1, message })
			}
		}
	}

	// Update final counts after relationship pass
	if (relDefs.length > 0) {
		await db
			.update(imports)
			.set({
				errorCount: errorCount + relationshipErrorCount,
				errors: errors.length > 0 ? errors : undefined,
				updatedAt: new Date(),
			})
			.where(eq(imports.id, importId))
	}

	logger.info('Import execution completed', {
		importId,
		successCount,
		errorCount,
		updatedCount,
		skippedCount,
		relationshipCount,
		relationshipErrorCount,
		totalRows: rows.length,
	})

	return {
		successCount,
		errorCount,
		updatedCount,
		skippedCount,
		relationshipCount,
		relationshipErrorCount,
		errors,
	}
}

// ── Dedup Matching Engine ───────────────────────────────────────────────
//
// Shared by the preview endpoint (dry-run, whole file) and the import
// processor's per-batch write path. Resolves each input row against existing
// objects in the workspace using the user-selected dedup keys, classifies
// the row as updated / created / skipped, and computes the per-column diff
// for matched rows so the caller can emit the correct audit record (T2) or
// preview diff (T3).

/** One concrete change between a CSV row and its matched existing object. */
export interface DedupColumnChange {
	column: string
	old: unknown
	new: unknown
}

/** A row that resolved to an existing object via the dedup keys. */
export interface DedupMatchedRow {
	rowIndex: number
	objectId: string
	/** Empty when the row would be a no-op (skipped). */
	changes: DedupColumnChange[]
}

export interface DedupClassification {
	/** Rows resolved to an existing object with at least one diff column. */
	updated: DedupMatchedRow[]
	/** Rows that had no matching existing object — would create a new record. */
	createdRowIndices: number[]
	/** Rows resolved to an existing object but with no diff columns — no-op. */
	skippedRowIndices: number[]
}

/**
 * Convert a dedup-key spec (`title` or `metadata.<field>`) into a column path
 * we can compare on both sides. `null` means the key does not exist on the
 * target type and the caller must reject the request before reaching here
 * (the route-level validator catches this).
 */
function resolveColumnValue(
	source: { title: string | null; metadata: Record<string, unknown> | null },
	dedupKey: string,
): string | null {
	if (dedupKey === 'title') {
		return source.title ?? null
	}
	if (dedupKey.startsWith('metadata.')) {
		const field = dedupKey.slice('metadata.'.length)
		const value = source.metadata?.[field]
		if (value === undefined || value === null) return null
		return String(value)
	}
	return null
}

/**
 * Build the dedup-key value tuple for a CSV row. Returns null when any
 * selected key resolves to an empty/missing value — per AC-T3 those rows
 * must never match (routed straight to "create new").
 */
function buildKeyTuple(
	row: Record<string, string>,
	typeMapping: TypeMapping,
	dedupKeys: string[],
): string[] | null {
	const values: string[] = []
	for (const dedupKey of dedupKeys) {
		const sourceColumn = typeMapping.columns.find(
			(c) => !c.skip && c.targetField === dedupKey,
		)?.sourceColumn
		if (!sourceColumn) return null
		const raw = row[sourceColumn]
		if (raw === undefined || raw === '') return null
		values.push(raw)
	}
	return values
}

/** Build the SQL fragment that selects existing objects for a column path. */
function dedupKeyEquals(dedupKey: string, value: string): SQL {
	if (dedupKey === 'title') {
		return sql`${objects.title} = ${value}`
	}
	const field = dedupKey.slice('metadata.'.length)
	// Per AC-T3, also guard against the column missing on the existing row
	// — JSONB `->>` returns NULL when the key isn't present, and SQL `NULL =
	// $val` is NULL (not true), so the IS NOT NULL is defence-in-depth.
	return sql`${objects.metadata} ->> ${field} IS NOT NULL AND ${objects.metadata} ->> ${field} = ${value}`
}

const MATCH_CHUNK_SIZE = 200

export async function matchRowsByDedupKeys(
	rows: Record<string, string>[],
	typeMapping: TypeMapping,
	workspaceId: string,
	settings: WorkspaceSettings,
	db: Database,
): Promise<DedupClassification> {
	const dedupKeys = typeMapping.dedupKeys ?? []
	if (dedupKeys.length === 0) {
		// No dedup keys → every row is a create (the caller already enforced
		// the createAllAsNew backstop at the route layer).
		return {
			updated: [],
			createdRowIndices: rows.map((_, i) => i),
			skippedRowIndices: [],
		}
	}

	// Pre-compute each row's mapped target values once — both for matching
	// (we need the dedup-key values) and for diffing matched rows.
	const mappedRows = rows.map((row, rowIndex) => {
		const mapped = mapRowForType(row, typeMapping, settings)
		const keyTuple = buildKeyTuple(row, typeMapping, dedupKeys)
		return { rowIndex, row, mapped, keyTuple }
	})

	// Rows that can never match (any empty key value) are immediately routed
	// to "create" without a DB roundtrip.
	const eligibleForMatching: typeof mappedRows = []
	const createdRowIndices: number[] = []
	for (const entry of mappedRows) {
		if (!entry.keyTuple) {
			createdRowIndices.push(entry.rowIndex)
			continue
		}
		eligibleForMatching.push(entry)
	}

	// Bucket eligible rows by their dedup-key tuple so duplicate CSV rows
	// share one DB lookup. Map key: JSON-encoded tuple → list of eligible
	// row entries with that tuple.
	const tupleToRows = new Map<string, typeof eligibleForMatching>()
	for (const entry of eligibleForMatching) {
		// keyTuple is guaranteed non-null here by the loop above.
		const tupleKey = JSON.stringify(entry.keyTuple)
		const bucket = tupleToRows.get(tupleKey)
		if (bucket) bucket.push(entry)
		else tupleToRows.set(tupleKey, [entry])
	}

	// Walk unique tuples in chunks, issue one SELECT per chunk that ORs all
	// per-tuple AND-clauses together. Postgres parameter limit is 65535 — at
	// 200 tuples × up to ~5 keys = 1000 params we stay well under it.
	const uniqueTuples = [...tupleToRows.keys()]
	const tupleToMatch = new Map<
		string,
		{
			id: string
			title: string | null
			metadata: Record<string, unknown> | null
			status: string
			content: string | null
			driver: string | null
		}
	>()

	for (let i = 0; i < uniqueTuples.length; i += MATCH_CHUNK_SIZE) {
		const chunkTupleKeys = uniqueTuples.slice(i, i + MATCH_CHUNK_SIZE)
		const orClauses: SQL[] = []
		for (const tupleKey of chunkTupleKeys) {
			const values = JSON.parse(tupleKey) as string[]
			const andParts: SQL[] = []
			for (let k = 0; k < dedupKeys.length; k++) {
				const key = dedupKeys[k]
				const val = values[k]
				if (key === undefined || val === undefined) continue
				andParts.push(dedupKeyEquals(key, val))
			}
			const combined = and(...andParts)
			if (combined) orClauses.push(combined)
		}
		if (orClauses.length === 0) continue

		const matches = await db
			.select({
				id: objects.id,
				title: objects.title,
				content: objects.content,
				status: objects.status,
				metadata: objects.metadata,
				driver: objects.driver,
			})
			.from(objects)
			.where(
				and(
					eq(objects.workspaceId, workspaceId),
					eq(objects.type, typeMapping.objectType),
					or(...orClauses),
				),
			)

		// Index matches by their dedup-key tuple. When multiple existing
		// objects collide on the same tuple (rare — usually a data-quality
		// issue), AC-T7 / architecture requires picking deterministically:
		// the lowest object_id wins so re-runs of the same import are
		// idempotent (AC-T6).
		for (const match of matches) {
			const tuple = dedupKeys.map((key) =>
				resolveColumnValue(
					{
						title: match.title,
						metadata: match.metadata as Record<string, unknown> | null,
					},
					key,
				),
			)
			if (tuple.some((v) => v === null || v === '')) continue
			const tupleKey = JSON.stringify(tuple)
			const existing = tupleToMatch.get(tupleKey)
			if (!existing || match.id < existing.id) {
				tupleToMatch.set(tupleKey, {
					id: match.id,
					title: match.title,
					content: match.content,
					status: match.status,
					metadata: (match.metadata as Record<string, unknown> | null) ?? null,
					driver: match.driver,
				})
			}
		}
	}

	// Classify each eligible row using the tuple→match index.
	const updated: DedupMatchedRow[] = []
	const skippedRowIndices: number[] = []

	for (const entry of eligibleForMatching) {
		if (!entry.keyTuple) continue
		const tupleKey = JSON.stringify(entry.keyTuple)
		const match = tupleToMatch.get(tupleKey)
		if (!match) {
			createdRowIndices.push(entry.rowIndex)
			continue
		}
		const changes = diffMappedRowAgainstObject(entry.row, entry.mapped, typeMapping, match)
		if (changes.length === 0) {
			skippedRowIndices.push(entry.rowIndex)
		} else {
			updated.push({ rowIndex: entry.rowIndex, objectId: match.id, changes })
		}
	}

	// Sort so the output order is deterministic across runs (helps tests +
	// keeps the first-25-diff cap stable when the same CSV is re-uploaded).
	createdRowIndices.sort((a, b) => a - b)
	skippedRowIndices.sort((a, b) => a - b)
	updated.sort((a, b) => a.rowIndex - b.rowIndex)

	return { updated, createdRowIndices, skippedRowIndices }
}

/**
 * Compute the changed-column diff between a matched existing object and the
 * mapped CSV row. Only columns the CSV provided a value for are diffed —
 * columns the CSV omits stay untouched (AC-T4). The `column` field in each
 * change mirrors the dotted `targetField` notation: `title`, `content`,
 * `status`, `driver`, or `metadata.<field>`.
 */
function diffMappedRowAgainstObject(
	row: Record<string, string>,
	mapped: ReturnType<typeof mapRowForType>,
	typeMapping: TypeMapping,
	existing: {
		title: string | null
		content: string | null
		status: string
		driver: string | null
		metadata: Record<string, unknown> | null
	},
): DedupColumnChange[] {
	const changes: DedupColumnChange[] = []
	if (!mapped) return changes

	// Build the set of target fields the CSV actually provided a value for —
	// only those participate in the diff. This is the column-level analogue
	// of "columns the CSV omits stay untouched" (AC-T4).
	const provided = new Set<string>()
	for (const col of typeMapping.columns) {
		if (col.skip) continue
		const raw = row[col.sourceColumn]
		if (raw === undefined || raw === '') continue
		provided.add(col.targetField)
	}

	if (provided.has('title') && mapped.title !== undefined && mapped.title !== existing.title) {
		changes.push({ column: 'title', old: existing.title, new: mapped.title })
	}
	if (
		provided.has('content') &&
		mapped.content !== undefined &&
		mapped.content !== existing.content
	) {
		changes.push({ column: 'content', old: existing.content, new: mapped.content })
	}
	if (provided.has('status') && mapped.status !== existing.status) {
		changes.push({ column: 'status', old: existing.status, new: mapped.status })
	}
	if (provided.has('driver') && mapped.driver !== undefined && mapped.driver !== existing.driver) {
		changes.push({ column: 'driver', old: existing.driver, new: mapped.driver })
	}

	const existingMetadata = (existing.metadata ?? {}) as Record<string, unknown>
	for (const targetField of provided) {
		if (!targetField.startsWith('metadata.')) continue
		const field = targetField.slice('metadata.'.length)
		const newValue = mapped.metadata[field]
		const oldValue = existingMetadata[field]
		// Loose equality through JSON canonicalization handles primitive
		// values (strings, numbers, booleans) consistently — both sides
		// originate from JSONB / mapped output, never deeply nested.
		if (JSON.stringify(newValue ?? null) !== JSON.stringify(oldValue ?? null)) {
			changes.push({ column: targetField, old: oldValue ?? null, new: newValue ?? null })
		}
	}

	return changes
}
