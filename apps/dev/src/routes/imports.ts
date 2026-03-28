import type { Database } from '@ai-native/db'
import { events, imports, workspaces } from '@ai-native/db/schema'
import { importMappingSchema, importQuerySchema } from '@ai-native/shared'
import type { StorageProvider } from '@ai-native/storage'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import {
	errorSchema,
	importListItemSchema,
	importResponseSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import type { WorkspaceSettings } from '../lib/types'
import { isWorkspaceMember } from '../lib/workspace-auth'
import { executeImport, generateMapping, parseFile } from '../services/import-processor'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		storageProvider: StorageProvider
	}
}

const app = new OpenAPIHono<Env>()

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

	// Validate workspace membership
	const isMember = await isWorkspaceMember(db, actorId, workspaceId)
	if (!isMember) {
		return c.json(createApiError('FORBIDDEN', 'Not a workspace member'), 403)
	}

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

	// Parse file
	let parsed: ReturnType<typeof parseFile>
	try {
		parsed = parseFile(buffer, fileType)
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

	// Generate auto-mapping
	const settings = workspace.settings as WorkspaceSettings
	const sampleRows = parsed.rows.slice(0, 10)
	const mapping = generateMapping(parsed.columns, sampleRows, settings)

	// Build preview
	const preview = {
		columns: parsed.columns,
		sampleRows: parsed.rows.slice(0, 5),
		totalRows: parsed.rows.length,
	}

	// Insert import record
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

	if (!importRecord) {
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
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const { mapping } = c.req.valid('json')

	const [importRecord] = await db
		.select()
		.from(imports)
		.where(and(eq(imports.id, id), eq(imports.workspaceId, workspaceId)))
		.limit(1)

	if (!importRecord) {
		return c.json(createApiError('NOT_FOUND', 'Import not found'), 404)
	}

	if (importRecord.status !== 'mapping') {
		return c.json(
			createApiError('CONFLICT', `Import is in '${importRecord.status}' state, not 'mapping'`),
			409,
		)
	}

	const [updated] = await db
		.update(imports)
		.set({ mapping, updatedAt: new Date() })
		.where(eq(imports.id, id))
		.returning()

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Import not found'), 404)
	}

	return c.json(serialize(updated) as z.infer<typeof importResponseSchema>, 200)
})

// ── Background import execution ─────────────────────────────────────────

function runImportInBackground(
	importId: string,
	fileStorageKey: string,
	fileType: string,
	mapping: z.infer<typeof importMappingSchema>,
	workspaceId: string,
	actorId: string,
	db: Database,
	storage: StorageProvider,
) {
	const run = async () => {
		const fileBuffer = await storage.get(fileStorageKey)
		const parsed = parseFile(fileBuffer, fileType)

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

		const finalStatus = result.successCount > 0 ? 'completed' : 'failed'
		await db
			.update(imports)
			.set({
				status: finalStatus,
				successCount: result.successCount,
				errorCount: result.errorCount,
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
			data: { successCount: result.successCount, errorCount: result.errorCount },
		})

		logger.info('Import finished', {
			importId,
			status: finalStatus,
			successCount: result.successCount,
			errorCount: result.errorCount,
		})
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
	const [importRecord] = await db
		.select()
		.from(imports)
		.where(and(eq(imports.id, id), eq(imports.workspaceId, workspaceId)))
		.limit(1)

	if (!importRecord) {
		return c.json(createApiError('NOT_FOUND', 'Import not found'), 404)
	}

	if (!importRecord.mapping) {
		return c.json(createApiError('BAD_REQUEST', 'No mapping configured'), 400)
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
	runImportInBackground(
		id,
		importRecord.fileStorageKey,
		importRecord.fileType,
		importRecord.mapping as z.infer<typeof importMappingSchema>,
		workspaceId,
		actorId,
		db,
		storage,
	)

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

	const [importRecord] = await db
		.select()
		.from(imports)
		.where(and(eq(imports.id, id), eq(imports.workspaceId, workspaceId)))
		.limit(1)

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

export default app
