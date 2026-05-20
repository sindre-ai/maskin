import { randomUUID } from 'node:crypto'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, files } from '@maskin/db/schema'
import {
	createFileSchema,
	fileDetailSchema,
	fileListItemSchema,
	updateFileSchema,
} from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, desc, eq, ilike } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, idParamSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import { isWorkspaceMember } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		storageProvider: StorageProvider
	}
}

const app = new OpenAPIHono<Env>()

// Built so the file's URL can be opened in a browser without further coordination.
// `FRONTEND_URL` is the same env var the OAuth callback uses for redirects.
function frontendBaseUrl(): string {
	return process.env.FRONTEND_URL || 'http://localhost:5173'
}

function fileStorageKey(workspaceId: string, fileId: string): string {
	return `workspaces/${workspaceId}/files/${fileId}`
}

// HTML/JS/SVG are forced to attachment so the browser cannot execute the bytes
// in our origin context — the viewer never embeds them inline.
const UNSAFE_INLINE_MIME = new Set([
	'text/html',
	'application/xhtml+xml',
	'image/svg+xml',
	'application/javascript',
	'text/javascript',
	'application/ecmascript',
	'text/ecmascript',
])

function disposition(mimeType: string, name: string): string {
	const safeName = name.replace(/[\\"\r\n]/g, '_')
	const isImage = mimeType.startsWith('image/') && !UNSAFE_INLINE_MIME.has(mimeType)
	const isText =
		(mimeType.startsWith('text/') || mimeType === 'application/json') &&
		!UNSAFE_INLINE_MIME.has(mimeType)
	const mode = isImage || isText ? 'inline' : 'attachment'
	return `${mode}; filename="${safeName}"`
}

function buildResponse(row: typeof files.$inferSelect, content: string) {
	const base = frontendBaseUrl()
	return {
		...serialize(row),
		content,
		url: `${base}/${row.workspaceId}/files/${row.id}`,
		downloadUrl: `${base}/api/files/${row.id}/download`,
	}
}

const listQuerySchema = z.object({
	q: z.string().trim().min(1).max(255).optional(),
	limit: z.coerce.number().int().positive().max(200).optional(),
	offset: z.coerce.number().int().nonnegative().optional(),
})

// -- POST / — Create file -----------------------------------------------------

const createFileRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Files'],
	summary: 'Create a file',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: createFileSchema } } },
	},
	responses: {
		201: {
			content: { 'application/json': { schema: fileDetailSchema } },
			description: 'File created',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		500: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Internal server error',
		},
	},
})

app.openapi(createFileRoute, (async (c) => {
	const db = c.get('db')
	const storage = c.get('storageProvider')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	const fileId = randomUUID()
	const storageKey = fileStorageKey(workspaceId, fileId)
	const bytes = Buffer.from(body.content, 'base64')
	const sizeBytes = bytes.byteLength

	// DB insert inside tx → S3 put → tx commits. If S3 put throws, the tx
	// rolls back and no row references the (never-written) key. If commit
	// fails after the put (rare), the S3 object is orphaned under the row's
	// UUID — inert because nothing else mints that UUID.
	let created: typeof files.$inferSelect | undefined
	let s3PutSucceeded = false
	try {
		created = await db.transaction(async (tx) => {
			const [row] = await tx
				.insert(files)
				.values({
					id: fileId,
					workspaceId,
					name: body.name,
					description: body.description ?? null,
					mimeType: body.mime_type,
					sizeBytes,
					storageKey,
					createdBy: actorId,
				})
				.returning()
			if (!row) throw new Error('INSERT returned no row')
			await storage.put(storageKey, bytes)
			s3PutSucceeded = true
			return row
		})
	} catch (err) {
		if (s3PutSucceeded) {
			logger.error('Orphan S3 object after file commit failure', {
				workspaceId,
				fileId,
				storageKey,
				error: String(err),
			})
		}
		throw err
	}

	if (!created) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create file'), 500)
	}

	// Audit event — never include the file content (8KB NOTIFY cap).
	try {
		await db.insert(events).values({
			workspaceId,
			actorId,
			action: 'created',
			entityType: 'file',
			entityId: created.id,
			data: {
				id: created.id,
				name: created.name,
				mimeType: created.mimeType,
				sizeBytes: created.sizeBytes,
			},
		})
	} catch (err) {
		logger.error('Failed to record file created audit event', {
			workspaceId,
			fileId: created.id,
			error: String(err),
		})
	}

	return c.json(buildResponse(created, body.content) as z.infer<typeof fileDetailSchema>, 201)
}) as RouteHandler<typeof createFileRoute, Env>)

// -- GET / — List files -------------------------------------------------------

const listFilesRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Files'],
	summary: 'List files in workspace',
	request: {
		headers: workspaceIdHeader,
		query: listQuerySchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.array(fileListItemSchema) } },
			description: 'Files list',
		},
	},
})

app.openapi(listFilesRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const query = c.req.valid('query')

	const limit = Number.isFinite(query.limit) && query.limit ? Math.min(query.limit, 200) : 50
	const offset = Number.isFinite(query.offset) && query.offset ? query.offset : 0

	const conditions = [eq(files.workspaceId, workspaceId)]
	if (query.q) conditions.push(ilike(files.name, `%${query.q}%`))

	const rows = await db
		.select({
			id: files.id,
			workspaceId: files.workspaceId,
			name: files.name,
			description: files.description,
			mimeType: files.mimeType,
			sizeBytes: files.sizeBytes,
			storageKey: files.storageKey,
			createdBy: files.createdBy,
			createdAt: files.createdAt,
			updatedAt: files.updatedAt,
		})
		.from(files)
		.where(and(...conditions))
		.orderBy(desc(files.createdAt))
		.limit(limit)
		.offset(offset)

	return c.json(serializeArray(rows) as z.infer<typeof fileListItemSchema>[], 200)
}) as RouteHandler<typeof listFilesRoute, Env>)

// -- GET /:id — Get file detail -----------------------------------------------

const getFileRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['Files'],
	summary: 'Get a file (with base64 content)',
	request: { params: idParamSchema },
	responses: {
		200: {
			content: { 'application/json': { schema: fileDetailSchema } },
			description: 'File detail',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'File not found',
		},
	},
})

app.openapi(getFileRoute, (async (c) => {
	const db = c.get('db')
	const storage = c.get('storageProvider')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	const [row] = await db.select().from(files).where(eq(files.id, id)).limit(1)
	if (!row || !(await isWorkspaceMember(db, actorId, row.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'File not found'), 404)
	}

	let content = ''
	try {
		const bytes = await storage.get(row.storageKey)
		content = bytes.toString('base64')
	} catch (err) {
		logger.error('Failed to read file bytes from storage', {
			fileId: row.id,
			storageKey: row.storageKey,
			error: String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to read file bytes'), 500)
	}

	return c.json(buildResponse(row, content) as z.infer<typeof fileDetailSchema>, 200)
}) as RouteHandler<typeof getFileRoute, Env>)

// -- GET /:id/download — Stream raw bytes ------------------------------------

const downloadFileRoute = createRoute({
	method: 'get',
	path: '/{id}/download',
	tags: ['Files'],
	summary: 'Download raw file bytes',
	request: { params: idParamSchema },
	responses: {
		200: {
			content: { 'application/octet-stream': { schema: z.string() } },
			description: 'Raw file bytes',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'File not found',
		},
	},
})

app.openapi(downloadFileRoute, (async (c) => {
	const db = c.get('db')
	const storage = c.get('storageProvider')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	const [row] = await db.select().from(files).where(eq(files.id, id)).limit(1)
	if (!row || !(await isWorkspaceMember(db, actorId, row.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'File not found'), 404)
	}

	const bytes = await storage.get(row.storageKey)
	// Force browsers to treat HTML/JS/SVG as downloads even if the agent uploaded
	// them with a text MIME type. `nosniff` blocks MIME-sniffing fallback so the
	// browser cannot escalate text/plain → text/html behind our back.
	c.header('Content-Type', row.mimeType)
	c.header('X-Content-Type-Options', 'nosniff')
	c.header('Content-Disposition', disposition(row.mimeType, row.name))
	c.header('Content-Length', String(bytes.byteLength))
	return c.body(bytes as unknown as ArrayBuffer)
}) as RouteHandler<typeof downloadFileRoute, Env>)

// -- PATCH /:id — Update file -------------------------------------------------

const updateFileRoute = createRoute({
	method: 'patch',
	path: '/{id}',
	tags: ['Files'],
	summary: 'Update file metadata or content',
	request: {
		params: idParamSchema,
		body: { content: { 'application/json': { schema: updateFileSchema } } },
	},
	responses: {
		200: {
			content: { 'application/json': { schema: fileDetailSchema } },
			description: 'File updated',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'File not found',
		},
	},
})

app.openapi(updateFileRoute, (async (c) => {
	const db = c.get('db')
	const storage = c.get('storageProvider')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	const [existing] = await db.select().from(files).where(eq(files.id, id)).limit(1)
	if (!existing || !(await isWorkspaceMember(db, actorId, existing.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'File not found'), 404)
	}

	const contentChanged = body.content !== undefined
	const newBytes = contentChanged ? Buffer.from(body.content as string, 'base64') : null
	const newSize = newBytes ? newBytes.byteLength : existing.sizeBytes

	const updated = await db.transaction(async (tx) => {
		const [locked] = await tx
			.select()
			.from(files)
			.where(eq(files.id, existing.id))
			.for('update')
			.limit(1)
		if (!locked) return undefined

		const [row] = await tx
			.update(files)
			.set({
				name: body.name ?? locked.name,
				description: body.description !== undefined ? body.description : locked.description,
				mimeType: body.mime_type ?? locked.mimeType,
				sizeBytes: newSize,
				updatedAt: new Date(),
			})
			.where(eq(files.id, existing.id))
			.returning()
		if (!row) return undefined

		if (newBytes) {
			await storage.put(locked.storageKey, newBytes)
		}
		return row
	})

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'File not found'), 404)
	}

	try {
		await db.insert(events).values({
			workspaceId: updated.workspaceId,
			actorId,
			action: 'updated',
			entityType: 'file',
			entityId: updated.id,
			data: {
				id: updated.id,
				name: updated.name,
				mimeType: updated.mimeType,
				sizeBytes: updated.sizeBytes,
			},
		})
	} catch (err) {
		logger.error('Failed to record file updated audit event', {
			workspaceId: updated.workspaceId,
			fileId: updated.id,
			error: String(err),
		})
	}

	// Re-read latest bytes for the response so the caller sees the post-update content.
	let contentB64 = ''
	try {
		const bytes = newBytes ?? (await storage.get(updated.storageKey))
		contentB64 = bytes.toString('base64')
	} catch (err) {
		logger.error('Failed to read file bytes after update', {
			fileId: updated.id,
			error: String(err),
		})
	}

	return c.json(buildResponse(updated, contentB64) as z.infer<typeof fileDetailSchema>, 200)
}) as RouteHandler<typeof updateFileRoute, Env>)

// -- DELETE /:id — Delete file ------------------------------------------------

const deleteFileRoute = createRoute({
	method: 'delete',
	path: '/{id}',
	tags: ['Files'],
	summary: 'Delete a file',
	request: { params: idParamSchema },
	responses: {
		200: {
			content: { 'application/json': { schema: z.object({ deleted: z.boolean() }) } },
			description: 'File deleted',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'File not found',
		},
	},
})

app.openapi(deleteFileRoute, (async (c) => {
	const db = c.get('db')
	const storage = c.get('storageProvider')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	const [existing] = await db.select().from(files).where(eq(files.id, id)).limit(1)
	if (!existing || !(await isWorkspaceMember(db, actorId, existing.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'File not found'), 404)
	}

	// DB first — the row is the source of truth. S3 delete after is
	// best-effort; an orphan object keyed on the deleted file's UUID is
	// inert because future creates mint a new UUID = new key.
	await db.delete(files).where(eq(files.id, existing.id))

	try {
		await storage.delete(existing.storageKey)
	} catch (err) {
		logger.error('Failed to delete file from storage (orphan object left)', {
			fileId: existing.id,
			storageKey: existing.storageKey,
			error: String(err),
		})
	}

	try {
		await db.insert(events).values({
			workspaceId: existing.workspaceId,
			actorId,
			action: 'deleted',
			entityType: 'file',
			entityId: existing.id,
			data: {
				id: existing.id,
				name: existing.name,
				mimeType: existing.mimeType,
				sizeBytes: existing.sizeBytes,
			},
		})
	} catch (err) {
		logger.error('Failed to record file deleted audit event', {
			workspaceId: existing.workspaceId,
			fileId: existing.id,
			error: String(err),
		})
	}

	return c.json({ deleted: true as const }, 200)
}) as RouteHandler<typeof deleteFileRoute, Env>)

export default app
