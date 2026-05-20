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

// The file URL is the whole point of this feature: agents paste it into Slack,
// emails, comments. Shipping a `http://localhost:5173/...` link from prod would
// silently break every share, so require `FRONTEND_URL` outside of dev and fail
// loud instead of returning a broken URL.
const DEV_FRONTEND_FALLBACK = 'http://localhost:5173'

function isProduction(): boolean {
	return process.env.NODE_ENV === 'production'
}

function frontendBaseUrl(): string {
	const url = process.env.FRONTEND_URL
	if (url) return url
	if (isProduction()) {
		throw new Error('FRONTEND_URL must be set in production to mint shareable file URLs')
	}
	return DEV_FRONTEND_FALLBACK
}

function fileStorageKey(workspaceId: string, fileId: string): string {
	return `workspaces/${workspaceId}/files/${fileId}`
}

function buildResponse(row: typeof files.$inferSelect, content: string, frontendUrl: string) {
	return {
		...serialize(row),
		content,
		url: `${frontendUrl}/${row.workspaceId}/files/${row.id}`,
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

	// Resolve the frontend URL up front. If FRONTEND_URL is missing in prod we
	// fail before any side effects — otherwise we'd write a row + S3 object,
	// then 500 the response, and a retry would create another pair.
	let frontendUrl: string
	try {
		frontendUrl = frontendBaseUrl()
	} catch (err) {
		logger.error('Cannot mint file URL', { error: String(err) })
		return c.json(createApiError('INTERNAL_ERROR', 'File URL not configured'), 500)
	}

	const fileId = randomUUID()
	const storageKey = fileStorageKey(workspaceId, fileId)
	const bytes = Buffer.from(body.content, 'base64')
	const sizeBytes = bytes.byteLength

	// Insert + commit first, then S3 put. Keeping the put outside the tx
	// avoids holding row locks and a DB connection open for the upload
	// duration. If the put fails we compensate by deleting the row; the
	// row is invisible to other callers between the two steps because
	// nothing else mints this UUID.
	const [created] = await db
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
	if (!created) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create file'), 500)
	}

	try {
		await storage.put(storageKey, bytes)
	} catch (err) {
		logger.error('S3 put failed; rolling back file row', {
			workspaceId,
			fileId: created.id,
			storageKey,
			error: String(err),
		})
		try {
			await db.delete(files).where(eq(files.id, created.id))
		} catch (cleanupErr) {
			logger.error('Failed to delete file row after S3 put failure (orphan row left)', {
				fileId: created.id,
				error: String(cleanupErr),
			})
		}
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to store file bytes'), 500)
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

	return c.json(
		buildResponse(created, body.content, frontendUrl) as z.infer<typeof fileDetailSchema>,
		201,
	)
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

	let frontendUrl: string
	try {
		frontendUrl = frontendBaseUrl()
	} catch (err) {
		logger.error('Cannot mint file URL', { error: String(err) })
		return c.json(createApiError('INTERNAL_ERROR', 'File URL not configured'), 500)
	}

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

	return c.json(buildResponse(row, content, frontendUrl) as z.infer<typeof fileDetailSchema>, 200)
}) as RouteHandler<typeof getFileRoute, Env>)

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

	let frontendUrl: string
	try {
		frontendUrl = frontendBaseUrl()
	} catch (err) {
		logger.error('Cannot mint file URL', { error: String(err) })
		return c.json(createApiError('INTERNAL_ERROR', 'File URL not configured'), 500)
	}

	const [existing] = await db.select().from(files).where(eq(files.id, id)).limit(1)
	if (!existing || !(await isWorkspaceMember(db, actorId, existing.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'File not found'), 404)
	}

	const contentChanged = body.content !== undefined
	const newBytes = contentChanged ? Buffer.from(body.content as string, 'base64') : null
	const newSize = newBytes ? newBytes.byteLength : existing.sizeBytes

	// Metadata update inside a tx with FOR UPDATE to serialize concurrent
	// patches. S3 put happens after commit — same pattern as create — so
	// the row lock is released before the (potentially slow) upload.
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
		return row
	})

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'File not found'), 404)
	}

	if (newBytes) {
		try {
			await storage.put(updated.storageKey, newBytes)
		} catch (err) {
			// The metadata row already committed with the new sizeBytes/mimeType,
			// but the bytes failed to upload — the row now points at stale or
			// missing content. Log loud; we can't trivially roll back the row
			// because we don't know the prior size/mime in scope. Callers will
			// see the inconsistency on next GET.
			logger.error('S3 put failed during file update; row metadata may be stale', {
				fileId: updated.id,
				storageKey: updated.storageKey,
				error: String(err),
			})
			return c.json(createApiError('INTERNAL_ERROR', 'Failed to store file bytes'), 500)
		}
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

	return c.json(
		buildResponse(updated, contentB64, frontendUrl) as z.infer<typeof fileDetailSchema>,
		200,
	)
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
