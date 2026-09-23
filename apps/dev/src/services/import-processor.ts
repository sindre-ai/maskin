import type { Database, Transaction } from '@maskin/db'
import { imports, objects, relationships } from '@maskin/db/schema'
import {
	type CsvOptions,
	type ImportMapping,
	OBJECT_DIFF_FIELDS,
	type TypeMapping,
	computeChanges,
} from '@maskin/shared'
import { parse } from 'csv-parse/sync'
import { type SQL, and, eq, inArray, sql } from 'drizzle-orm'
import { capturePosthogRelationshipCreated, recordEvents } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { deriveEndpointKinds } from '../lib/relationships-endpoint-kind'
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
	/** Rows that matched an existing object (or an earlier row in the file) and were left alone */
	skippedCount: number
	/** Rows that matched an existing object (or an earlier row in the file) and were merged into it */
	updatedCount: number
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
	/** False when `status` is the default fallback rather than a value from the row */
	statusProvided: boolean
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

	const statusProvided = status !== undefined
	// Fall back to default status
	if (!status) {
		status = typeMapping.defaultStatus ?? settings.statuses?.[type]?.[0] ?? 'new'
	}

	return { type, title, content, status, statusProvided, metadata, driver }
}

// ── Matching against existing objects ───────────────────────────────────

// The whitespace JS `\s` matches, spelled out so the same pattern means the same
// thing in a JS RegExp and a Postgres ARE. Postgres `btrim(x)` strips only ASCII
// spaces and `\s` there is locale-dependent, so neither can stand in for `trim()`.
const MATCH_KEY_SPACE =
	'[ \\t\\n\\v\\f\\r\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]'
const MATCH_KEY_TRIM_PATTERN = `^${MATCH_KEY_SPACE}+|${MATCH_KEY_SPACE}+$`
const MATCH_KEY_TRIM_RE = new RegExp(MATCH_KEY_TRIM_PATTERN, 'g')

function trimMatchValue(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined
	const trimmed = String(value).replace(MATCH_KEY_TRIM_RE, '')
	return trimmed === '' ? undefined : trimmed
}

function normalizeMatchKey(value: unknown): string | undefined {
	return trimMatchValue(value)?.toLowerCase()
}

/** The trimmed value of `matchOn` for a mapped row, or undefined when the row has none. */
function matchValueFor(mapped: MappedRow, matchOn: string): string | undefined {
	if (matchOn === 'title') return trimMatchValue(mapped.title)
	return trimMatchValue(mapped.metadata[matchOn.slice('metadata.'.length)])
}

/** The normalized value of `matchOn` for a mapped row, or undefined when the row has none. */
export function matchKeyFor(mapped: MappedRow, matchOn: string): string | undefined {
	return normalizeMatchKey(matchValueFor(mapped, matchOn))
}

/** Trim + lowercase in SQL, with the same trim set as `trimMatchValue`. */
function sqlMatchKey(value: SQL): SQL {
	return sql`lower(regexp_replace(${value}, ${MATCH_KEY_TRIM_PATTERN}, '', 'g'))`
}

const MATCH_LOOKUP_CHUNK = 500

/**
 * Map each normalized key to the id of an existing object of `objectType` whose
 * `matchOn` value matches it. When the workspace already holds several objects
 * with the same key, the oldest one wins, ties broken by id so the pick is stable.
 *
 * `values` are the rows' trimmed values, not their JS-lowercased keys: both
 * sides of the comparison are lowercased by Postgres `lower()`, so a collation
 * whose case folding differs from JS `toLowerCase()` cannot make them disagree.
 */
async function findExistingByKey(
	db: Database,
	workspaceId: string,
	objectType: string,
	matchOn: string,
	values: string[],
): Promise<Map<string, string>> {
	const found = new Map<string, string>()
	// Literal, table-qualified column references — see known-pitfalls.md on
	// Drizzle column objects rendering unqualified inside raw `sql` templates.
	const stored =
		matchOn === 'title'
			? sql`objects.title`
			: sql`objects.metadata ->> ${matchOn.slice('metadata.'.length)}`
	for (let i = 0; i < values.length; i += MATCH_LOOKUP_CHUNK) {
		const chunk = values.slice(i, i + MATCH_LOOKUP_CHUNK)
		const rows = (await db.execute(sql`
			SELECT k.value AS value, objects.id AS id
			FROM unnest(ARRAY[${sql.join(
				chunk.map((v) => sql`${v}`),
				sql`, `,
			)}]::text[]) AS k(value)
			JOIN objects
				ON objects.workspace_id = ${workspaceId}
				AND objects.type = ${objectType}
				AND ${sqlMatchKey(stored)} = ${sqlMatchKey(sql`k.value`)}
			ORDER BY objects.created_at ASC, objects.id ASC
		`)) as unknown as Array<{ value: string; id: string }>
		for (const row of rows) {
			const key = normalizeMatchKey(row.value)
			if (key && !found.has(key)) found.set(key, row.id)
		}
	}
	return found
}

/** Fold a later row into an earlier one for the same object: later values win, metadata merges. */
function mergeMapped(base: MappedRow, next: MappedRow): MappedRow {
	return {
		type: base.type,
		title: next.title ?? base.title,
		content: next.content ?? base.content,
		status: next.statusProvided ? next.status : base.status,
		statusProvided: base.statusProvided || next.statusProvided,
		metadata: { ...base.metadata, ...next.metadata },
		driver: next.driver ?? base.driver,
	}
}

interface PendingInsert {
	rowIndexes: number[]
	mapped: MappedRow
	tmIndex: number
	key?: string
}

interface PendingUpdate {
	rowIndexes: number[]
	mapped: MappedRow
}

/**
 * Write matched rows onto their existing objects. Only fields the row actually
 * supplied are touched: an unmapped status keeps the object's status rather
 * than resetting it to the import default, and metadata is shallow-merged the
 * same way PATCH /objects/:id merges it. Objects whose values would not change
 * are left alone so a re-import of unchanged data writes nothing.
 */
async function applyMatchedUpdates(
	tx: Transaction,
	updates: Map<string, PendingUpdate>,
	workspaceId: string,
	actorId: string,
): Promise<void> {
	const currentRows = await tx
		.select()
		.from(objects)
		.where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, [...updates.keys()])))
		.for('update')

	const updateEvents: Parameters<typeof recordEvents>[1] = []
	for (const current of currentRows) {
		const entry = updates.get(current.id)
		if (!entry) continue
		const { mapped } = entry

		const next = {
			title: mapped.title ?? current.title,
			content: mapped.content ?? current.content,
			status: mapped.statusProvided ? mapped.status : current.status,
			driver: mapped.driver ?? current.driver,
			metadata:
				Object.keys(mapped.metadata).length > 0
					? { ...((current.metadata as Record<string, unknown> | null) ?? {}), ...mapped.metadata }
					: current.metadata,
		}
		const changes = computeChanges(
			current as unknown as Record<string, unknown>,
			{ ...current, ...next } as unknown as Record<string, unknown>,
			OBJECT_DIFF_FIELDS,
		)
		if (changes.length === 0) continue

		await tx
			.update(objects)
			.set({ ...next, updatedAt: new Date() })
			.where(eq(objects.id, current.id))
		updateEvents.push({
			workspaceId,
			actorId,
			action: current.status !== next.status ? 'status_changed' : 'updated',
			entityType: current.type,
			entityId: current.id,
			data: { changes },
		})
	}
	await recordEvents(tx, updateEvents)
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
	let skippedCount = 0
	let updatedCount = 0
	let relationshipCount = 0
	let relationshipErrorCount = 0
	const errors: ImportError[] = []

	const relDefs = mapping.relationships ?? []
	const onMatch = mapping.onMatch ?? 'skip'
	// Track (rowIndex, objectType) → created (or matched) object ID for relationship pass
	const rowTypeToObjectId = new Map<string, string>()

	// ── Pass 0: Look up existing objects for type mappings with a match key ──
	// Keyed by type-mapping index. Pass 1 adds every object it creates, so a key
	// that repeats in a later batch matches the object an earlier batch created.
	const knownByKey = new Map<number, Map<string, string>>()
	for (const [tmIndex, typeMapping] of mapping.typeMappings.entries()) {
		const { matchOn } = typeMapping
		if (!matchOn) continue
		const values = new Set<string>()
		for (const row of rows) {
			const mapped = mapRowForType(row, typeMapping, settings)
			const value = mapped ? matchValueFor(mapped, matchOn) : undefined
			if (value) values.add(value)
		}
		knownByKey.set(
			tmIndex,
			values.size > 0
				? await findExistingByKey(db, workspaceId, typeMapping.objectType, matchOn, [...values])
				: new Map(),
		)
	}

	// ── Pass 1: Create objects ──────────────────────────────────────────
	for (let i = 0; i < rows.length; i += BATCH_SIZE) {
		const batch = rows.slice(i, i + BATCH_SIZE)
		const batchErrors: ImportError[] = []

		// `rowIndexes` lists every file row that resolves to the object — more
		// than one when a match key repeats within the batch.
		const toInsert: PendingInsert[] = []
		const pendingByKey = new Map<string, PendingInsert>()
		const toUpdate = new Map<string, PendingUpdate>()
		let batchUpdated = 0

		for (let j = 0; j < batch.length; j++) {
			const rowIndex = i + j // 0-based internally; +1 for user-facing error messages
			const row = batch[j]
			if (!row) continue

			for (const [tmIndex, typeMapping] of mapping.typeMappings.entries()) {
				const mapped = mapRowForType(row, typeMapping, settings)
				if (!mapped) continue

				const known = knownByKey.get(tmIndex)
				const key =
					known && typeMapping.matchOn ? matchKeyFor(mapped, typeMapping.matchOn) : undefined
				if (!known || !key) {
					toInsert.push({ rowIndexes: [rowIndex], mapped, tmIndex })
					continue
				}

				const existingId = known.get(key)
				if (existingId) {
					rowTypeToObjectId.set(`${rowIndex}::${mapped.type}`, existingId)
					if (onMatch === 'update') {
						const prev = toUpdate.get(existingId)
						toUpdate.set(
							existingId,
							prev
								? {
										rowIndexes: [...prev.rowIndexes, rowIndex],
										mapped: mergeMapped(prev.mapped, mapped),
									}
								: { rowIndexes: [rowIndex], mapped },
						)
						batchUpdated++
					} else {
						skippedCount++
					}
					continue
				}

				// Same key earlier in this batch — fold into that pending insert
				const pending = pendingByKey.get(`${tmIndex}::${key}`)
				if (pending) {
					pending.rowIndexes.push(rowIndex)
					if (onMatch === 'update') {
						pending.mapped = mergeMapped(pending.mapped, mapped)
						batchUpdated++
					} else {
						skippedCount++
					}
					continue
				}

				const entry: PendingInsert = { rowIndexes: [rowIndex], mapped, tmIndex, key }
				pendingByKey.set(`${tmIndex}::${key}`, entry)
				toInsert.push(entry)
			}
		}

		if (toInsert.length > 0 || toUpdate.size > 0) {
			try {
				const createdObjects = await db.transaction(async (tx) => {
					let created: (typeof objects.$inferSelect)[] = []
					if (toInsert.length > 0) {
						created = await tx
							.insert(objects)
							.values(
								toInsert.map(({ mapped }) => ({
									workspaceId,
									type: mapped.type,
									title: mapped.title,
									content: mapped.content,
									status: mapped.status,
									metadata: Object.keys(mapped.metadata).length > 0 ? mapped.metadata : undefined,
									driver: mapped.driver,
									createdBy: actorId,
								})),
							)
							.returning()

						if (created.length > 0) {
							await recordEvents(
								tx,
								created.map((obj) => ({
									workspaceId,
									actorId,
									action: 'created' as const,
									entityType: obj.type,
									entityId: obj.id,
									data: { id: obj.id, type: obj.type, title: obj.title },
								})),
							)
						}
					}
					if (toUpdate.size > 0) {
						await applyMatchedUpdates(tx, toUpdate, workspaceId, actorId)
					}
					return created
				})

				// Index created objects for relationship matching and later-batch key matches
				for (let k = 0; k < toInsert.length; k++) {
					const entry = toInsert[k]
					const obj = createdObjects[k]
					if (!entry || !obj) continue

					for (const rowIndex of entry.rowIndexes) {
						rowTypeToObjectId.set(`${rowIndex}::${obj.type}`, obj.id)
					}
					if (entry.key) knownByKey.get(entry.tmIndex)?.set(entry.key, obj.id)
				}

				successCount += createdObjects.length
				updatedCount += batchUpdated
			} catch (err) {
				const uniqueRows = [
					...new Set([
						...toInsert.flatMap(({ rowIndexes }) => rowIndexes),
						...[...toUpdate.values()].flatMap(({ rowIndexes }) => rowIndexes),
					]),
				].sort((a, b) => a - b)
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
				skippedCount,
				updatedCount,
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

		// Insert relationships in batches. The CSV import spec supplies
		// static `sourceType`/`targetType` labels ('object' historically), but a
		// downstream row id can legitimately resolve to a file — funnel every
		// endpoint id through the centralised helper so a CSV that references a
		// file endpoint gets the correct label without needing to widen the
		// mapping schema. Batch-lookup once, then per-batch insert.
		for (let i = 0; i < relBatch.length; i += BATCH_SIZE) {
			const batch = relBatch.slice(i, i + BATCH_SIZE)
			const kindByEndpointId = await deriveEndpointKinds(
				db,
				workspaceId,
				batch.flatMap((r) => [r.sourceId, r.targetId]),
			)
			try {
				const created = await db
					.insert(relationships)
					.values(
						batch.map((r) => ({
							sourceType: kindByEndpointId.get(r.sourceId) ?? r.sourceType,
							sourceId: r.sourceId,
							targetType: kindByEndpointId.get(r.targetId) ?? r.targetType,
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
					await recordEvents(
						db,
						created.map((rel) => ({
							workspaceId,
							actorId,
							action: 'created' as const,
							entityType: 'relationship',
							entityId: rel.id,
							data: rel,
						})),
					)
					// PostHog · one capture per relationships write, source of truth
					// for the ship-metric across every prod writer. Fire-and-forget.
					for (const rel of created) {
						capturePosthogRelationshipCreated(actorId, {
							workspaceId,
							sourceType: rel.sourceType,
							targetType: rel.targetType,
							type: rel.type,
						})
					}
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
		skippedCount,
		updatedCount,
		relationshipCount,
		relationshipErrorCount,
		totalRows: rows.length,
	})

	return {
		successCount,
		errorCount,
		skippedCount,
		updatedCount,
		relationshipCount,
		relationshipErrorCount,
		errors,
	}
}
