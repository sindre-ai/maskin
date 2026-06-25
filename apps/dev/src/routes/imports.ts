import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, importAuditRows, imports, workspaces } from '@maskin/db/schema'
import { getAllValidTypes, getEnabledModuleIds } from '@maskin/module-sdk'
import {
	type CsvOptions,
	importAuditRowsQuerySchema,
	importMappingSchema,
	importQuerySchema,
} from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, asc, desc, eq } from 'drizzle-orm'
import { trackBulkImportExecuted } from '../lib/analytics/import-events'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import {
	errorSchema,
	importAuditRowResponseSchema,
	importListItemSchema,
	importPreviewResponseSchema,
	importResponseSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import type { WorkspaceSettings } from '../lib/types'
import { isWorkspaceMember } from '../lib/workspace-auth'
import {
	detectCsvOptions,
	executeImport,
	generateMapping,
	matchRowsByDedupKeys,
	parseFile,
} from '../services/import-processor'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		storageProvider: StorageProvider
	}
}

const app = new OpenAPIHono<Env>()

// All import routes require workspace membership
app.use('*', async (c, next) => {
	const workspaceId = c.req.header('x-workspace-id')
	if (!workspaceId) {
		return c.json(createApiError('BAD_REQUEST', 'Missing X-Workspace-Id header'), 400)
	}
	const db = c.get('db')
	const actorId = c.get('actorId')
	const isMember = await isWorkspaceMember(db, actorId, workspaceId)
	if (!isMember) {
		return c.json(createApiError('FORBIDDEN', 'Not a workspace member'), 403)
	}
	return next()
})

function findImport(db: Database, id: string, workspaceId: string) {
	return db
		.select()
		.from(imports)
		.where(and(eq(imports.id, id), eq(imports.workspaceId, workspaceId)))
		.limit(1)
		.then((rows) => rows[0])
}

/**
 * Validate dedup-key shape on every typeMapping of an import mapping. Each
 * key must resolve to a real attribute of the target type — `title` (the
 * top-level column) or `metadata.<existingField>` where `<existingField>`
 * is declared in workspace `settings.field_definitions[objectType]`.
 *
 * Also enforces the AC-U4 server backstop: when `dedupKeys` is empty the
 * caller must explicitly opt into the "create all as new" escape hatch via
 * `createAllAsNew: true`. The frontend is the primary gate (T4); this catch
 * keeps no-key imports from sneaking through if the UI is bypassed.
 *
 * Returns null on success or a `[message, fieldErrors]` tuple on failure.
 */
function validateDedupKeys(
	mapping: z.infer<typeof importMappingSchema>,
	settings: WorkspaceSettings,
): { message: string; errors: { field: string; message: string }[] } | null {
	const fieldDefs = settings.field_definitions ?? {}
	for (let i = 0; i < mapping.typeMappings.length; i++) {
		const tm = mapping.typeMappings[i]
		if (!tm) continue
		const keys = tm.dedupKeys ?? []

		// AC-U4 backstop — no key + no explicit escape hatch ⇒ reject.
		if (keys.length === 0 && tm.createAllAsNew !== true) {
			return {
				message:
					'Importing without a dedup key creates duplicates for every row — pick at least one field, or confirm "Create all as new".',
				errors: [
					{
						field: `mapping.typeMappings[${i}].dedupKeys`,
						message: 'dedupKeys is empty and createAllAsNew is not set — set one or the other.',
					},
				],
			}
		}

		// Per-key shape: must equal `title` or `metadata.<field>` where the
		// field is declared on the target type's workspace settings.
		const typeFields = (fieldDefs[tm.objectType] ?? []).map((f) => f.name)
		for (const key of keys) {
			if (key === 'title') continue
			if (key.startsWith('metadata.')) {
				const fieldName = key.slice('metadata.'.length)
				if (typeFields.includes(fieldName)) continue
			}
			return {
				message: `Invalid dedup key '${key}' on type '${tm.objectType}' — not an attribute of that type.`,
				errors: [
					{
						field: `mapping.typeMappings[${i}].dedupKeys`,
						message: `'${key}' is not a valid attribute on '${tm.objectType}'`,
					},
				],
			}
		}
	}
	return null
}

// ── POST / — Upload file, parse, auto-map, return preview ──────────────

const createImportRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Imports'],
	summary: 'Upload a file and create an import job with auto-mapped fields',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'multipart/form-data': {
					schema: z.object({
						file: z.any().openapi({ type: 'string', format: 'binary' }),
					}),
				},
			},
		},
	},
	responses: {
		201: {
			content: { 'application/json': { schema: importResponseSchema } },
			description: 'Import created with preview and suggested mapping',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid file or parse error',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a workspace member',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Workspace not found',
		},
	},
})

app.openapi(createImportRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const storage = c.get('storageProvider')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	// Fetch workspace for settings
	const [workspace] = await db
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)

	if (!workspace) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	// Read file from multipart
	const formData = await c.req.formData()
	const file = formData.get('file')

	if (!file || !(file instanceof File)) {
		return c.json(createApiError('BAD_REQUEST', 'No file provided'), 400)
	}

	// File size limit (10MB)
	const MAX_FILE_SIZE = 10 * 1024 * 1024
	if (file.size > MAX_FILE_SIZE) {
		return c.json(createApiError('BAD_REQUEST', 'File too large. Maximum size is 10MB.'), 400)
	}

	// Determine file type
	const fileName = file.name
	const ext = fileName.split('.').pop()?.toLowerCase()
	if (!ext || !['csv', 'json'].includes(ext)) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				`Unsupported file type: .${ext}`,
				[],
				'Supported formats: .csv, .json',
			),
			400,
		)
	}
	const fileType = ext as 'csv' | 'json'

	// Read file contents
	const buffer = Buffer.from(await file.arrayBuffer())

	// Auto-detect CSV options
	const csvOptions = fileType === 'csv' ? detectCsvOptions(buffer) : undefined

	// Parse file
	let parsed: ReturnType<typeof parseFile>
	try {
		parsed = parseFile(buffer, fileType, csvOptions)
	} catch (err) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				`Failed to parse file: ${err instanceof Error ? err.message : String(err)}`,
			),
			400,
		)
	}

	// Generate import ID for S3 key
	const importId = crypto.randomUUID()
	const storageKey = `imports/${workspaceId}/${importId}/${fileName}`

	// Store raw file in S3
	await storage.put(storageKey, buffer)

	// Generate auto-mapping (includes detected csvOptions)
	const settings = workspace.settings as WorkspaceSettings
	const sampleRows = parsed.rows.slice(0, 10)
	const mapping = generateMapping(parsed.columns, sampleRows, settings, csvOptions)

	// Build preview
	const preview = {
		columns: parsed.columns,
		sampleRows: parsed.rows.slice(0, 5),
		totalRows: parsed.rows.length,
	}

	// Insert import record — clean up S3 if this fails
	const cleanupS3 = () =>
		storage
			.delete(storageKey)
			.catch((delErr) =>
				logger.error('Failed to clean up S3 file after DB error', { storageKey, error: delErr }),
			)

	const [importRecord] = await db
		.insert(imports)
		.values({
			id: importId,
			workspaceId,
			status: 'mapping',
			fileName,
			fileType,
			fileStorageKey: storageKey,
			totalRows: parsed.rows.length,
			mapping,
			preview,
			source: 'file',
			createdBy: actorId,
		})
		.returning()
		.catch(async (err) => {
			await cleanupS3()
			throw err
		})

	if (!importRecord) {
		await cleanupS3()
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create import'), 400)
	}

	// Log event
	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'created',
		entityType: 'import',
		entityId: importRecord.id,
		data: { fileName, fileType, totalRows: parsed.rows.length },
	})

	return c.json(serialize(importRecord) as z.infer<typeof importResponseSchema>, 201)
})

// ── PATCH /:id/mapping — Update mapping ────────────────────────────────

const updateMappingRoute = createRoute({
	method: 'patch',
	path: '/{id}/mapping',
	tags: ['Imports'],
	summary: 'Update the field mapping for an import job',
	request: {
		headers: workspaceIdHeader,
		params: z.object({ id: z.string().uuid() }),
		body: {
			content: {
				'application/json': {
					schema: z.object({ mapping: importMappingSchema }),
				},
			},
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: importResponseSchema } },
			description: 'Mapping updated',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid mapping',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Import not found',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Import is not in mapping state',
		},
	},
})

app.openapi(updateMappingRoute, async (c) => {
	const db = c.get('db')
	const storage = c.get('storageProvider')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const { mapping } = c.req.valid('json')

	const importRecord = await findImport(db, id, workspaceId)

	if (!importRecord) {
		return c.json(createApiError('NOT_FOUND', 'Import not found'), 404)
	}

	if (importRecord.status !== 'mapping') {
		return c.json(
			createApiError('CONFLICT', `Import is in '${importRecord.status}' state, not 'mapping'`),
			409,
		)
	}

	// Check if CSV options changed — if so, re-parse the file from storage.
	// Compare fields directly: JSON.stringify is order-sensitive and Postgres JSONB
	// doesn't preserve key insertion order, so a round-trip through the DB returns
	// keys in a different order than Zod's parsed output (delimiter/encoding flip).
	// Stringify-based comparison would spuriously report a change and trigger the
	// regeneration branch below, silently overwriting the user's chosen objectType.
	const existingMapping = importRecord.mapping as { csvOptions?: CsvOptions } | null
	const newCsvOptions = mapping.csvOptions
	const existingCsvOptions = existingMapping?.csvOptions
	const csvOptionsChanged =
		importRecord.fileType === 'csv' &&
		!!newCsvOptions &&
		(newCsvOptions.delimiter !== existingCsvOptions?.delimiter ||
			newCsvOptions.encoding !== existingCsvOptions?.encoding)

	let finalMapping = mapping
	let updatedPreview = undefined
	let updatedTotalRows = undefined

	if (csvOptionsChanged) {
		try {
			const fileBuffer = await storage.get(importRecord.fileStorageKey)
			const parsed = parseFile(fileBuffer, importRecord.fileType, newCsvOptions)

			// Fetch workspace settings for re-mapping
			const [workspace] = await db
				.select()
				.from(workspaces)
				.where(eq(workspaces.id, workspaceId))
				.limit(1)
			const settings = (workspace?.settings ?? {}) as WorkspaceSettings

			// Regenerate mapping with new CSV options
			const sampleRows = parsed.rows.slice(0, 10)
			finalMapping = generateMapping(parsed.columns, sampleRows, settings, newCsvOptions)

			updatedPreview = {
				columns: parsed.columns,
				sampleRows: parsed.rows.slice(0, 5),
				totalRows: parsed.rows.length,
			}
			updatedTotalRows = parsed.rows.length
		} catch (err) {
			return c.json(
				createApiError(
					'BAD_REQUEST',
					`Failed to re-parse file with new settings: ${err instanceof Error ? err.message : String(err)}`,
				),
				400,
			)
		}
	}

	const [updated] = await db
		.update(imports)
		.set({
			mapping: finalMapping,
			...(updatedPreview ? { preview: updatedPreview } : {}),
			...(updatedTotalRows !== undefined ? { totalRows: updatedTotalRows } : {}),
			updatedAt: new Date(),
		})
		.where(eq(imports.id, id))
		.returning()

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Import not found'), 404)
	}

	return c.json(serialize(updated) as z.infer<typeof importResponseSchema>, 200)
})

// ── POST /:id/preview — Dry-run match against existing objects ────────

const previewImportRoute = createRoute({
	method: 'post',
	path: '/{id}/preview',
	tags: ['Imports'],
	summary:
		'Preview an import: match the parsed file against existing objects using the dedup keys and return counts + the first 25 diff rows.',
	request: {
		headers: workspaceIdHeader,
		params: z.object({ id: z.string().uuid() }),
		body: {
			content: {
				'application/json': {
					schema: z.object({ mapping: importMappingSchema }),
				},
			},
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: importPreviewResponseSchema } },
			description: 'Preview counts and per-row diffs',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid mapping or dedup keys',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Import not found',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Import is not in mapping state',
		},
	},
})

const PREVIEW_DIFF_LIMIT = 25

app.openapi(previewImportRoute, async (c) => {
	const db = c.get('db')
	const storage = c.get('storageProvider')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const { mapping } = c.req.valid('json')

	const importRecord = await findImport(db, id, workspaceId)
	if (!importRecord) {
		return c.json(createApiError('NOT_FOUND', 'Import not found'), 404)
	}

	// Preview only makes sense while the import is still being configured.
	// Reject after the user has confirmed so we never run a dry-run against
	// stale mapping after the real import has started.
	if (importRecord.status !== 'mapping') {
		return c.json(
			createApiError('CONFLICT', `Import is in '${importRecord.status}' state, not 'mapping'`),
			409,
		)
	}

	const [workspace] = await db
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!workspace) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}
	const settings = (workspace.settings ?? {}) as WorkspaceSettings

	// Validate target type is enabled (same check as confirm — avoids letting
	// preview succeed on a mapping that would fail confirm anyway).
	const enabledModules = getEnabledModuleIds(settings as Record<string, unknown>)
	const validTypes = getAllValidTypes(enabledModules, settings)
	for (const tm of mapping.typeMappings) {
		if (!tm.objectType || !validTypes.includes(tm.objectType)) {
			return c.json(
				createApiError(
					'BAD_REQUEST',
					`Invalid object type '${tm.objectType}' in import mapping`,
					[
						{
							field: 'mapping.typeMappings[].objectType',
							message: `'${tm.objectType}' is not enabled in this workspace`,
							expected: validTypes.length > 0 ? validTypes.join(' | ') : 'any enabled type',
							received: `'${tm.objectType ?? ''}'`,
						},
					],
					'Pick a valid object type in the import mapping step before previewing.',
				),
				400,
			)
		}
	}

	const validation = validateDedupKeys(mapping, settings)
	if (validation) {
		return c.json(createApiError('BAD_REQUEST', validation.message, validation.errors), 400)
	}

	// Re-parse the file from storage to run the match against the actual rows
	// the import would write at confirm time. Using the stored mapping's
	// csvOptions keeps preview consistent with confirm.
	let rows: Record<string, string>[]
	try {
		const fileBuffer = await storage.get(importRecord.fileStorageKey)
		const parsed = parseFile(fileBuffer, importRecord.fileType, mapping.csvOptions)
		rows = parsed.rows
	} catch (err) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				`Failed to parse file: ${err instanceof Error ? err.message : String(err)}`,
			),
			400,
		)
	}

	// Aggregate counts across all typeMappings — for the common single-type
	// import the second loop collapses to one entry; multi-type imports add
	// per-type buckets together. Diffs are interleaved per-type then capped.
	let matched = 0
	let created = 0
	let skipped = 0
	const allDiffs: {
		row_index: number
		object_id: string
		changes: { column: string; old: unknown; new: unknown }[]
	}[] = []

	for (const tm of mapping.typeMappings) {
		const classification = await matchRowsByDedupKeys(rows, tm, workspaceId, settings, db)
		matched += classification.updated.length
		created += classification.createdRowIndices.length
		skipped += classification.skippedRowIndices.length
		for (const row of classification.updated) {
			allDiffs.push({
				row_index: row.rowIndex,
				object_id: row.objectId,
				changes: row.changes,
			})
		}
	}

	allDiffs.sort((a, b) => a.row_index - b.row_index)
	const diffs = allDiffs.slice(0, PREVIEW_DIFF_LIMIT)

	logger.info('Import preview computed', {
		importId: id,
		workspaceId,
		totalRows: rows.length,
		matched,
		created,
		skipped,
		diffsReturned: diffs.length,
	})

	return c.json(
		{ matched, created, skipped, diffs } as z.infer<typeof importPreviewResponseSchema>,
		200,
	)
})

// ── Background import execution ─────────────────────────────────────────

function runImportInBackground(opts: {
	importId: string
	fileStorageKey: string
	fileType: string
	mapping: z.infer<typeof importMappingSchema>
	workspaceId: string
	actorId: string
	db: Database
	storage: StorageProvider
}) {
	const { importId, fileStorageKey, fileType, mapping, workspaceId, actorId, db, storage } = opts
	const run = async () => {
		const fileBuffer = await storage.get(fileStorageKey)
		const parsed = parseFile(fileBuffer, fileType, mapping.csvOptions)

		const [workspace] = await db
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.limit(1)

		const settings = (workspace?.settings ?? {}) as WorkspaceSettings
		const result = await executeImport(
			importId,
			parsed.rows,
			mapping,
			workspaceId,
			actorId,
			settings,
			db,
		)

		const totalErrors = result.errorCount + result.relationshipErrorCount
		const totalResolved = result.successCount + result.updatedCount + result.skippedCount
		// An import counts as completed if *any* row resolved cleanly (create,
		// update, or skip) — a dedup re-run that only skips is still a success.
		const finalStatus = totalResolved > 0 ? 'completed' : 'failed'
		await db
			.update(imports)
			.set({
				status: finalStatus,
				successCount: result.successCount,
				updatedCount: result.updatedCount,
				skippedCount: result.skippedCount,
				errorCount: totalErrors,
				errors: result.errors.length > 0 ? result.errors : null,
				processedRows: parsed.rows.length,
				completedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(imports.id, importId))

		await db.insert(events).values({
			workspaceId,
			actorId,
			action: finalStatus === 'completed' ? 'import_completed' : 'import_failed',
			entityType: 'import',
			entityId: importId,
			data: {
				successCount: result.successCount,
				updatedCount: result.updatedCount,
				skippedCount: result.skippedCount,
				errorCount: totalErrors,
				relationshipCount: result.relationshipCount,
			},
		})

		logger.info('Import finished', {
			importId,
			status: finalStatus,
			successCount: result.successCount,
			updatedCount: result.updatedCount,
			skippedCount: result.skippedCount,
			errorCount: result.errorCount,
			relationshipCount: result.relationshipCount,
			relationshipErrorCount: result.relationshipErrorCount,
		})

		if (finalStatus === 'completed') {
			void trackBulkImportExecuted({
				mapping,
				matchedCount: result.updatedCount,
				createdCount: result.successCount,
				skippedCount: result.skippedCount,
				totalRows: parsed.rows.length,
				workspaceId,
				actorId,
			})
		}
	}

	run().catch(async (err) => {
		logger.error('Import background execution failed', { importId, error: err })
		await db
			.update(imports)
			.set({
				status: 'failed',
				errors: [
					{ row: 0, message: `Import failed: ${err instanceof Error ? err.message : String(err)}` },
				],
				updatedAt: new Date(),
			})
			.where(eq(imports.id, importId))
			.catch((updateErr) =>
				logger.error('Failed to update import status after error', { importId, error: updateErr }),
			)
	})
}

// ── POST /:id/confirm — Execute the import ─────────────────────────────

const confirmImportRoute = createRoute({
	method: 'post',
	path: '/{id}/confirm',
	tags: ['Imports'],
	summary: 'Confirm and execute the import, creating objects in batches',
	request: {
		headers: workspaceIdHeader,
		params: z.object({ id: z.string().uuid() }),
	},
	responses: {
		202: {
			content: { 'application/json': { schema: importResponseSchema } },
			description: 'Import accepted and started in background',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'No mapping configured',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Import not found',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Import is not in mapping state',
		},
	},
})

app.openapi(confirmImportRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const storage = c.get('storageProvider')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')

	// Fetch import record (needed for 404 and mapping check)
	const importRecord = await findImport(db, id, workspaceId)

	if (!importRecord) {
		return c.json(createApiError('NOT_FOUND', 'Import not found'), 404)
	}

	if (!importRecord.mapping) {
		return c.json(createApiError('BAD_REQUEST', 'No mapping configured'), 400)
	}

	// Reject early if the import is no longer in the 'mapping' state. The atomic UPDATE
	// below also catches this race, but checking first avoids a workspace lookup we don't
	// need and keeps the failure mode predictable for tests.
	if (importRecord.status !== 'mapping') {
		return c.json(
			createApiError('CONFLICT', `Import is in '${importRecord.status}' state, not 'mapping'`),
			409,
		)
	}

	// Validate every typeMapping.objectType against the workspace's current statuses.
	// Without this, executeImport would silently fall back to 'new' status and could
	// produce objects with a stale type that no longer exists in the workspace.
	const [workspace] = await db
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!workspace) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}
	const settings = (workspace.settings ?? {}) as WorkspaceSettings
	// Use the same resolution as POST /objects: module-provided types merged with
	// settings.statuses. Plain Object.keys(settings.statuses) misses module types
	// whose statuses haven't been overridden, which would reject valid mappings.
	const enabledModules = getEnabledModuleIds(settings as Record<string, unknown>)
	const validTypes = getAllValidTypes(enabledModules, settings)
	const mapping = importRecord.mapping as z.infer<typeof importMappingSchema>
	for (const tm of mapping.typeMappings ?? []) {
		if (!tm.objectType || !validTypes.includes(tm.objectType)) {
			return c.json(
				createApiError(
					'BAD_REQUEST',
					`Invalid object type '${tm.objectType}' in import mapping`,
					[
						{
							field: 'mapping.typeMappings[].objectType',
							message: `'${tm.objectType}' is not enabled in this workspace`,
							expected: validTypes.length > 0 ? validTypes.join(' | ') : 'any enabled type',
							received: `'${tm.objectType ?? ''}'`,
						},
					],
					'Pick a valid object type in the import mapping step before confirming.',
				),
				400,
			)
		}
	}

	// Dedup-key shape + AC-U4 server backstop. The frontend is the primary
	// gate for the empty-keys-without-escape-hatch case (T4); this rejects
	// imports that bypass the UI with no dedup keys configured.
	const dedupValidation = validateDedupKeys(mapping, settings)
	if (dedupValidation) {
		return c.json(
			createApiError('BAD_REQUEST', dedupValidation.message, dedupValidation.errors),
			400,
		)
	}

	// Atomically claim the import — only succeeds if status is still 'mapping'
	const [updated] = await db
		.update(imports)
		.set({ status: 'importing', updatedAt: new Date() })
		.where(and(eq(imports.id, id), eq(imports.status, 'mapping')))
		.returning()

	if (!updated) {
		return c.json(
			createApiError('CONFLICT', `Import is in '${importRecord.status}' state, not 'mapping'`),
			409,
		)
	}

	// Log event
	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'import_started',
		entityType: 'import',
		entityId: id,
		data: { totalRows: importRecord.totalRows },
	})

	// Run execution in background — don't block the response
	runImportInBackground({
		importId: id,
		fileStorageKey: importRecord.fileStorageKey,
		fileType: importRecord.fileType,
		mapping: importRecord.mapping as z.infer<typeof importMappingSchema>,
		workspaceId,
		actorId,
		db,
		storage,
	})

	return c.json(serialize(updated) as z.infer<typeof importResponseSchema>, 202)
})

// ── GET /:id — Get import by ID ────────────────────────────────────────

const getImportRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['Imports'],
	summary: 'Get import details including progress and errors',
	request: {
		headers: workspaceIdHeader,
		params: z.object({ id: z.string().uuid() }),
	},
	responses: {
		200: {
			content: { 'application/json': { schema: importResponseSchema } },
			description: 'Import details',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Import not found',
		},
	},
})

app.openapi(getImportRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')

	const importRecord = await findImport(db, id, workspaceId)

	if (!importRecord) {
		return c.json(createApiError('NOT_FOUND', 'Import not found'), 404)
	}

	return c.json(serialize(importRecord) as z.infer<typeof importResponseSchema>, 200)
})

// ── GET / — List imports ───────────────────────────────────────────────

const listImportsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Imports'],
	summary: 'List import jobs for workspace',
	request: {
		headers: workspaceIdHeader,
		query: importQuerySchema,
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z.array(importListItemSchema),
				},
			},
			description: 'List of imports',
		},
	},
})

app.openapi(listImportsRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const query = c.req.valid('query')

	const conditions = [eq(imports.workspaceId, workspaceId)]
	if (query.status) {
		conditions.push(eq(imports.status, query.status))
	}

	const records = await db
		.select({
			id: imports.id,
			workspaceId: imports.workspaceId,
			status: imports.status,
			fileName: imports.fileName,
			fileType: imports.fileType,
			totalRows: imports.totalRows,
			processedRows: imports.processedRows,
			successCount: imports.successCount,
			errorCount: imports.errorCount,
			updatedCount: imports.updatedCount,
			skippedCount: imports.skippedCount,
			source: imports.source,
			createdBy: imports.createdBy,
			createdAt: imports.createdAt,
			updatedAt: imports.updatedAt,
			completedAt: imports.completedAt,
		})
		.from(imports)
		.where(and(...conditions))
		.orderBy(desc(imports.createdAt))
		.limit(query.limit)
		.offset(query.offset)

	return c.json(serializeArray(records) as z.infer<typeof importListItemSchema>[], 200)
})

// ── GET /:id/audit-rows — Per-row audit entries for an import ──────────
//
// Powers AC-U5: the audit detail page lists which rows were created vs
// updated and which attributes changed on each updated row. The route
// scopes by workspace via the parent import lookup so an audit row can't
// leak across workspaces, then paginates by `row_index asc` to give the
// detail page a deterministic top-down view of the import.

const listImportAuditRowsRoute = createRoute({
	method: 'get',
	path: '/{id}/audit-rows',
	tags: ['Imports'],
	summary: 'List per-row audit entries for an import (paginated by row_index asc)',
	request: {
		headers: workspaceIdHeader,
		params: z.object({ id: z.string().uuid() }),
		query: importAuditRowsQuerySchema,
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z.array(importAuditRowResponseSchema),
				},
			},
			description: 'List of audit rows',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Import not found',
		},
	},
})

app.openapi(listImportAuditRowsRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const { limit, offset } = c.req.valid('query')

	// Workspace-scope check via the parent import — keeps audit rows from
	// leaking even if a caller knows an import id from another workspace.
	const importRecord = await findImport(db, id, workspaceId)
	if (!importRecord) {
		return c.json(createApiError('NOT_FOUND', 'Import not found'), 404)
	}

	const records = await db
		.select()
		.from(importAuditRows)
		.where(eq(importAuditRows.importId, id))
		.orderBy(asc(importAuditRows.rowIndex))
		.limit(limit)
		.offset(offset)

	logger.info('Listed import audit rows', {
		importId: id,
		workspaceId,
		returned: records.length,
		limit,
		offset,
	})

	return c.json(
		serializeArray(records) as z.infer<typeof importAuditRowResponseSchema>[],
		200,
	)
})

export default app
