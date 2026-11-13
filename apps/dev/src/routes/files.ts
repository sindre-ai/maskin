import { randomUUID } from 'node:crypto'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { fileUploads, files, relationships } from '@maskin/db/schema'
import {
	MAX_INLINE_FILE_SIZE_BYTES,
	completeFileUploadSchema,
	createFileSchema,
	fileDetailSchema,
	fileKindSchema,
	fileListItemSchema,
	fileReadFormatSchema,
	fileTagChangeResultSchema,
	fileTagCountSchema,
	fileTagMatchSchema,
	type fileTextDetailSchema,
	fileUploadSessionSchema,
	isTextMimeType,
	mergeFileTagsSchema,
	parseFileTagFilter,
	planFileUploadParts,
	renameFileTagSchema,
	startFileUploadSchema,
	updateFileSchema,
} from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { trackFileSaved } from '../lib/analytics/file-events'
import { linkFilesToConversation } from '../lib/conversation-file-links'
import {
	buildCreatedAtCursorConditions,
	msCreatedAt,
	useKeysetSeek,
} from '../lib/cursor-pagination'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import {
	FileEditError,
	FileSaveTimeoutError,
	FileVersionConflictError,
	ensureContentHash,
	saveFile,
	sha256Hex,
} from '../lib/file-save'
import { FileTagExistsError, FileTagNotFoundError, changeFileTag } from '../lib/file-tag-change'
import { abortStoredUpload, classifyCompleteFailure, deleteStoredObject } from '../lib/file-uploads'
import { fileStorageKey, fileViewerUrl, frontendBaseUrl } from '../lib/file-urls'
import {
	HtmlTooDeepError,
	MAX_HTML_TEXT_INPUT_BYTES,
	extractHtmlText,
	readableWithHint,
} from '../lib/html-text'
import { htmlViewerWarning } from '../lib/html-viewer-warning'
import { logger } from '../lib/logger'
import { errorSchema, idParamSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import { insertStoredFile, recordFileCreated } from '../lib/stored-file'
import {
	assertWorkspaceWriterRole,
	isWorkspaceMember,
	isWorkspaceWriter,
} from '../lib/workspace-auth'
import { assertInWorkspace } from '../lib/workspace-scope'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType?: string
		/** Caller's role in the X-Workspace-Id workspace, set by authMiddleware. */
		workspaceRole?: string
		storageProvider: StorageProvider
		/** Set by app-factory when the request carried a well-formed
		 * `X-Maskin-Session-Id` header — the S2 writer hook reads it to attribute
		 * file mutations to their originating session. */
		maskinSessionId?: string
		/** Set by authMiddleware for a session key: the session the key was minted for. */
		apiKeySessionId?: string | null
	}
}

/**
 * The session a file mutation belongs to. The caller's session key names it, so a plain
 * HTTP call from the agent's computer counts; the header is the fallback for other keys.
 */
function producingSessionId(
	apiKeySessionId: string | null | undefined,
	headerSessionId: string | undefined,
): string | undefined {
	return apiKeySessionId ?? headerSessionId
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

function buildResponse(
	row: typeof files.$inferSelect,
	bytes: Buffer,
	frontendUrl: string,
	warning?: string,
	/** Set on a raw read: points a reader of a mostly-embedded-data HTML file at format=text. */
	readableWith?: string | null,
) {
	const encoding = isTextMimeType(row.mimeType) ? 'utf8' : 'base64'
	return {
		...serialize(row),
		annotations: row.annotations ?? [],
		url: fileViewerUrl(frontendUrl, row.workspaceId, row.id),
		// Ahead of `content` on purpose: a reader that stops early, or a tool
		// result cut at a character cap, still sees the hint.
		...(readableWith ? { readable_with: readableWith } : {}),
		content: bytes.toString(encoding),
		encoding,
		...(warning ? { warning } : {}),
	}
}

const HTML_MIME_TYPES = new Set(['text/html', 'application/xhtml+xml'])

/** The object an edge ties this file to (derived_from or relates_to), if any. */
async function findSourceObjectId(db: Database, fileId: string): Promise<string | undefined> {
	const edges = await db
		.select()
		.from(relationships)
		.where(
			and(
				inArray(relationships.type, ['derived_from', 'relates_to']),
				or(
					and(eq(relationships.sourceType, 'file'), eq(relationships.sourceId, fileId)),
					and(eq(relationships.targetType, 'file'), eq(relationships.targetId, fileId)),
				),
			),
		)
		.orderBy(asc(relationships.createdAt))
	for (const e of edges) {
		if (e.sourceType === 'file' && e.sourceId === fileId && e.targetType === 'object') {
			return e.targetId
		}
		if (e.targetType === 'file' && e.targetId === fileId && e.sourceType === 'object') {
			return e.sourceId
		}
	}
	return undefined
}

/** How long a download URL for a large file stays valid. */
const DOWNLOAD_URL_TTL_SECONDS = 60 * 60
/** How long a started upload may take to finish (also how long its part URLs live). */
const UPLOAD_TTL_SECONDS = 12 * 60 * 60

function isLargeFile(row: { sizeBytes: number }): boolean {
	return row.sizeBytes > MAX_INLINE_FILE_SIZE_BYTES
}

// Media the browser plays or shows in place; everything else downloads.
function opensInline(mimeType: string): boolean {
	return /^(video|audio|image)\//.test(mimeType) || mimeType === 'application/pdf'
}

function contentDispositionFor(name: string, mimeType: string): string {
	// RFC 5987 encoding keeps the header ASCII-only, which storage requires.
	const encoded = encodeURIComponent(name).replace(
		/['()*]/g,
		(ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
	)
	return `${opensInline(mimeType) ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`
}

/**
 * Response for a file too large to inline: metadata plus a short-lived URL that
 * serves the bytes straight from storage, so the API never buffers them.
 */
async function buildLargeFileResponse(
	storage: StorageProvider,
	row: typeof files.$inferSelect,
	frontendUrl: string,
) {
	const downloadUrl = await storage.presignDownload(row.storageKey, {
		expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
		contentType: row.mimeType,
		contentDisposition: contentDispositionFor(row.name, row.mimeType),
	})
	return {
		...serialize(row),
		content: '',
		encoding: 'base64' as const,
		contentOmitted: true as const,
		downloadUrl,
		annotations: row.annotations ?? [],
		url: fileViewerUrl(frontendUrl, row.workspaceId, row.id),
	}
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const listQuerySchema = z.object({
	q: z.string().trim().min(1).max(255).optional(),
	ids: z.string().optional(),
	kind: fileKindSchema.optional(),
	// Comma-separated; trimmed and lowercased like tags on write.
	tags: z.string().optional(),
	tags_match: fileTagMatchSchema.optional(),
	limit: z.coerce.number().int().positive().max(200).optional(),
	offset: z.coerce.number().int().nonnegative().optional(),
	order: z.enum(['asc', 'desc']).optional(),
	// Snapshot-consistent cursor pagination — mirrors `objectQuerySchema`.
	snapshot_at: z.string().datetime().optional(),
	cursor_created_at: z.string().datetime().optional(),
	cursor_id: z.string().uuid().optional(),
})

// -- POST / — Create file -----------------------------------------------------

const createFileRoute = createRoute({
	method: 'post',
	path: '/',
	'x-viewer-policy': 'writer',
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
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const body = c.req.valid('json')

	// A chat or work item the caller names must belong to this workspace; checked before
	// anything is written, like every other id that comes out of a request body.
	await assertInWorkspace(db, workspaceId, {
		conversations: [body.conversation_id],
		objects: [body.object_id],
	})

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
	const bytes = Buffer.from(body.content, body.encoding)
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
			kind: body.kind ?? null,
			tags: body.tags ?? [],
			mimeType: body.mime_type,
			sizeBytes,
			storageKey,
			contentHash: sha256Hex(bytes),
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

	// The chat or work item the caller named. Best effort, like the provenance links: the
	// file is already stored, and a failed link never fails the create.
	if (body.conversation_id) {
		await linkFilesToConversation(db, {
			workspaceId,
			conversationId: body.conversation_id,
			fileIds: [created.id],
			createdBy: actorId,
		})
	}
	if (body.object_id) {
		try {
			await db
				.insert(relationships)
				.values({
					sourceType: 'object',
					sourceId: body.object_id,
					targetType: 'file',
					targetId: created.id,
					type: 'attached',
					createdBy: actorId,
				})
				.onConflictDoNothing({
					target: [relationships.sourceId, relationships.targetId, relationships.type],
				})
		} catch (err) {
			logger.warn('file attach to work item failed', {
				workspaceId,
				fileId: created.id,
				objectId: body.object_id,
				error: String(err),
			})
		}
	}

	// Audit event — never include the file content (8KB NOTIFY cap). Passes
	// provenance context so the S2 writer hook can also upsert a
	// `session → file` `produced_by` edge, and link the chat the session runs in to
	// the file unless the caller named a chat above.
	try {
		await recordEvent(db, {
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
			provenance: {
				sessionId: producingSessionId(c.get('apiKeySessionId'), c.get('maskinSessionId')),
				entityKind: 'file',
				...(body.conversation_id ? { conversationId: null } : {}),
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
		buildResponse(
			created,
			bytes,
			frontendUrl,
			htmlViewerWarning(created.mimeType, bytes.toString('utf8')),
		) as z.infer<typeof fileDetailSchema>,
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
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
	},
})

app.openapi(listFilesRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const query = c.req.valid('query')

	const rawIds = query.ids ? query.ids.split(',') : null
	if (rawIds?.some((id) => !UUID_RE.test(id))) {
		return c.json(createApiError('VALIDATION_ERROR', 'ids must be comma-separated UUIDs'), 400)
	}
	const ids = rawIds

	const limit = ids?.length
		? ids.length
		: Number.isFinite(query.limit) && query.limit
			? Math.min(query.limit, 200)
			: 50
	const offset = Number.isFinite(query.offset) && query.offset ? query.offset : 0

	const conditions = [eq(files.workspaceId, workspaceId)]
	if (query.q) conditions.push(ilike(files.name, `%${query.q}%`))
	if (ids?.length) conditions.push(inArray(files.id, ids))
	if (query.kind) conditions.push(eq(files.kind, query.kind))
	const filterTags = parseFileTagFilter(query.tags)
	if (filterTags.length > 0) {
		const wanted = sql`ARRAY[${sql.join(
			filterTags.map((t) => sql`${t}`),
			sql`, `,
		)}]::text[]`
		conditions.push(
			query.tags_match === 'any'
				? sql`${files.tags} && ${wanted}`
				: sql`${files.tags} @> ${wanted}`,
		)
	}
	conditions.push(
		...buildCreatedAtCursorConditions({ createdAt: files.createdAt, id: files.id }, query),
	)

	// The historical sort was `createdAt desc`. Under the cursor path append
	// `id asc` as a tiebreaker so the (createdAt, id) keyset seek remains a
	// strict-past comparison — flag-off callers keep the exact old orderBy.
	const cursorOn = Boolean(query.snapshot_at)
	const orderBy = cursorOn
		? query.order === 'asc'
			? [asc(msCreatedAt(files.createdAt)), asc(files.id)]
			: [desc(msCreatedAt(files.createdAt)), asc(files.id)]
		: [desc(files.createdAt)]

	const skipOffset = useKeysetSeek(query)
	const rows = await db
		.select({
			id: files.id,
			workspaceId: files.workspaceId,
			name: files.name,
			description: files.description,
			kind: files.kind,
			tags: files.tags,
			mimeType: files.mimeType,
			sizeBytes: files.sizeBytes,
			storageKey: files.storageKey,
			createdBy: files.createdBy,
			createdAt: files.createdAt,
			updatedAt: files.updatedAt,
		})
		.from(files)
		.where(and(...conditions))
		.orderBy(...orderBy)
		.limit(limit)
		.offset(skipOffset ? 0 : offset)

	return c.json(serializeArray(rows) as z.infer<typeof fileListItemSchema>[], 200)
}) as RouteHandler<typeof listFilesRoute, Env>)

// -- GET /tags — Tags in use, with file counts ----------------------------------

// Plenty for a workspace's vocabulary; a longer tail than this is a sign tags are being
// used as free text.
const MAX_TAG_COUNT_ROWS = 500

const listTagsRoute = createRoute({
	method: 'get',
	path: '/tags',
	tags: ['Files'],
	summary: 'List the tags in use in the workspace and how many files carry each',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			content: { 'application/json': { schema: z.array(fileTagCountSchema) } },
			description: 'Tags, most-used first (ties in alphabetical order)',
		},
	},
})

app.openapi(listTagsRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const rows = (await db.execute(sql`
		SELECT t.tag AS tag, count(*)::int AS count
		FROM files f
		CROSS JOIN LATERAL unnest(f.tags) AS t(tag)
		WHERE f.workspace_id = ${workspaceId}
		GROUP BY t.tag
		ORDER BY count(*) DESC, t.tag ASC
		LIMIT ${MAX_TAG_COUNT_ROWS}
	`)) as unknown as Array<{ tag: string; count: number }>

	return c.json(
		Array.from(rows, (row) => ({ tag: row.tag, count: row.count })) as z.infer<
			typeof fileTagCountSchema
		>[],
		200,
	)
}) as RouteHandler<typeof listTagsRoute, Env>)

// -- POST /tags/rename and /tags/merge — Change a tag on every file ---------------

const fileTagChangeResponses = {
	200: {
		content: { 'application/json': { schema: fileTagChangeResultSchema } },
		description: 'Every file that carried the tag now carries the new one',
	},
	400: {
		content: { 'application/json': { schema: errorSchema } },
		description: 'Invalid tag, or the old and new tag are the same',
	},
	404: {
		content: { 'application/json': { schema: errorSchema } },
		description: 'No file in the workspace carries the tag; nothing was written',
	},
	409: {
		content: { 'application/json': { schema: errorSchema } },
		description: 'Rename only: the new name is already a tag; merge into it instead',
	},
}

const renameFileTagRoute = createRoute({
	method: 'post',
	path: '/tags/rename',
	'x-viewer-policy': 'writer',
	tags: ['Files'],
	summary: 'Rename a tag on every file in the workspace',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: renameFileTagSchema } } },
	},
	responses: fileTagChangeResponses,
})

const mergeFileTagsRoute = createRoute({
	method: 'post',
	path: '/tags/merge',
	'x-viewer-policy': 'writer',
	tags: ['Files'],
	summary: 'Merge a tag into another on every file in the workspace',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: mergeFileTagsSchema } } },
	},
	responses: fileTagChangeResponses,
})

type FileTagChangeOutcome =
	| { status: 200; body: { from: string; to: string; files_changed: number } }
	| { status: 400 | 404 | 409; body: ReturnType<typeof createApiError> }

async function runFileTagChange(
	db: Database,
	params: {
		workspaceId: string
		actorId: string
		kind: 'rename' | 'merge'
		from: string
		to: string
	},
): Promise<FileTagChangeOutcome> {
	const { from, to } = params
	if (from === to) {
		return {
			status: 400,
			body: createApiError('VALIDATION_ERROR', 'The old and new tag are the same'),
		}
	}
	try {
		const filesChanged = await changeFileTag(db, params)
		return { status: 200, body: { from, to, files_changed: filesChanged } }
	} catch (err) {
		if (err instanceof FileTagNotFoundError) {
			return { status: 404, body: createApiError('NOT_FOUND', err.message) }
		}
		if (err instanceof FileTagExistsError) {
			return { status: 409, body: createApiError('CONFLICT', err.message) }
		}
		throw err
	}
}

app.openapi(renameFileTagRoute, (async (c) => {
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { from, to } = c.req.valid('json')
	const out = await runFileTagChange(c.get('db'), {
		workspaceId,
		actorId: c.get('actorId'),
		kind: 'rename',
		from,
		to,
	})
	return c.json(out.body, out.status)
}) as RouteHandler<typeof renameFileTagRoute, Env>)

app.openapi(mergeFileTagsRoute, (async (c) => {
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { from, into } = c.req.valid('json')
	const out = await runFileTagChange(c.get('db'), {
		workspaceId,
		actorId: c.get('actorId'),
		kind: 'merge',
		from,
		to: into,
	})
	return c.json(out.body, out.status)
}) as RouteHandler<typeof mergeFileTagsRoute, Env>)

// -- GET /:id — Get file detail -----------------------------------------------

const getFileRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['Files'],
	summary: 'Get a file (content as plain text for text MIME types, base64 for binary)',
	request: {
		params: idParamSchema,
		query: z.object({
			format: fileReadFormatSchema.optional().openapi({
				description:
					'raw (default) returns the stored bytes. text returns the words in a text file: for HTML, markdown extracted from the page (no styles, scripts or embedded fonts) as content_text; other text files unchanged. Non-text files ignore it.',
			}),
		}),
	},
	responses: {
		200: {
			content: { 'application/json': { schema: fileDetailSchema } },
			// With format=text and a text file the body is fileTextDetailSchema
			// instead (content_text in place of content). It is not declared as a
			// union here so the generated native clients keep one response type.
			description:
				'File detail. With format=text on a text file: content_text, extracted, title, meta_description, note (when the page is drawn by script), json_ld and source_object_id instead of content and encoding.',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid format, or an HTML file too large to extract text from',
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
	const { format } = c.req.valid('query')

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

	if (isLargeFile(row)) {
		try {
			return c.json(
				(await buildLargeFileResponse(storage, row, frontendUrl)) as z.infer<
					typeof fileDetailSchema
				>,
				200,
			)
		} catch (err) {
			logger.error('Failed to presign file download', { fileId: row.id, error: String(err) })
			return c.json(createApiError('INTERNAL_ERROR', 'Failed to create download URL'), 500)
		}
	}

	let bytes: Buffer
	try {
		bytes = await storage.get(row.storageKey)
	} catch (err) {
		logger.error('Failed to read file bytes from storage', {
			fileId: row.id,
			storageKey: row.storageKey,
			error: String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to read file bytes'), 500)
	}

	const contentHash = await ensureContentHash(db, row, bytes)

	if (format === 'text' && isTextMimeType(row.mimeType)) {
		const text = bytes.toString('utf8')
		const isHtml = HTML_MIME_TYPES.has(row.mimeType.toLowerCase())
		const base = {
			...serialize({ ...row, contentHash }),
			annotations: row.annotations ?? [],
			url: fileViewerUrl(frontendUrl, row.workspaceId, row.id),
		}
		if (!isHtml) {
			return c.json(
				{ ...base, content_text: text, extracted: false } as z.infer<typeof fileTextDetailSchema>,
				200,
			)
		}
		if (bytes.byteLength > MAX_HTML_TEXT_INPUT_BYTES) {
			return c.json(
				createApiError(
					'VALIDATION_ERROR',
					`This HTML file is ${bytes.byteLength} bytes, too large to extract text from (limit ${MAX_HTML_TEXT_INPUT_BYTES}). Read it with format=raw.`,
				),
				400,
			)
		}
		let extracted: ReturnType<typeof extractHtmlText>
		try {
			extracted = extractHtmlText(text)
		} catch (err) {
			if (err instanceof HtmlTooDeepError) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						`This HTML file is nested more than ${err.maxDepth} levels deep, too deep to extract text from. Read it with format=raw.`,
					),
					400,
				)
			}
			logger.error('Failed to extract text from HTML file', { fileId: row.id, error: String(err) })
			return c.json(createApiError('INTERNAL_ERROR', 'Failed to extract text from the file'), 500)
		}
		let sourceObjectId: string | undefined
		try {
			sourceObjectId = await findSourceObjectId(db, row.id)
		} catch (err) {
			logger.warn('Failed to look up source object for file', {
				fileId: row.id,
				error: String(err),
			})
		}
		return c.json(
			{
				...base,
				content_text: extracted.contentText,
				extracted: true,
				title: extracted.title,
				meta_description: extracted.description,
				...(extracted.note ? { note: extracted.note } : {}),
				...(extracted.jsonLd.length > 0 ? { json_ld: extracted.jsonLd } : {}),
				...(sourceObjectId ? { source_object_id: sourceObjectId } : {}),
			} as z.infer<typeof fileTextDetailSchema>,
			200,
		)
	}

	const readableWith = HTML_MIME_TYPES.has(row.mimeType.toLowerCase())
		? readableWithHint(bytes.toString('utf8'), bytes.byteLength)
		: null

	return c.json(
		buildResponse({ ...row, contentHash }, bytes, frontendUrl, undefined, readableWith) as z.infer<
			typeof fileDetailSchema
		>,
		200,
	)
}) as RouteHandler<typeof getFileRoute, Env>)

// -- PATCH /:id — Update file -------------------------------------------------

// 409 body: the standard error envelope plus the hash the file has now, so a
// client can tell what it is comparing against without guessing.
const versionConflictSchema = errorSchema.extend({ currentHash: z.string() })

const updateFileRoute = createRoute({
	method: 'patch',
	path: '/{id}',
	'x-viewer-policy': 'writer',
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
			description:
				'Invalid request, or an edit that cannot be applied (text not found, found more than once without replace_all, file is not text)',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'File not found',
		},
		409: {
			content: { 'application/json': { schema: versionConflictSchema } },
			description: 'if_match does not match the stored content hash; nothing was written',
		},
		503: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Timed out waiting for the file or storage; nothing was written, retry is safe',
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
	if (!existing || !(await isWorkspaceWriter(db, actorId, existing.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'File not found'), 404)
	}

	// A large file's bytes are never loaded here, so they cannot be replaced or
	// hashed for if_match. Only its metadata can change.
	const large = isLargeFile(existing)
	if (large && body.content !== undefined) {
		return c.json(
			createApiError(
				'VALIDATION_ERROR',
				'The content of a file larger than 50 MB cannot be replaced; upload a new file instead',
			),
			400,
		)
	}

	if (large && body.edits !== undefined) {
		return c.json(
			createApiError(
				'VALIDATION_ERROR',
				'A file larger than 50 MB cannot be edited; upload a new file instead',
			),
			400,
		)
	}

	const newBytes =
		body.content !== undefined ? Buffer.from(body.content, body.encoding ?? 'utf8') : null

	// Lock, version check, upload and commit happen inside saveFile (see
	// lib/file-save.ts), so the bytes are never uploaded after the lock is gone.
	let saved: Awaited<ReturnType<typeof saveFile>>
	try {
		saved = await saveFile(
			{ db, storage },
			{
				fileId: existing.id,
				ifMatch: large ? undefined : body.if_match,
				newBytes,
				edits: body.edits,
				name: body.name,
				description: body.description,
				kind: body.kind,
				tags: body.tags,
				mimeType: body.mime_type,
				annotations: body.annotations,
			},
		)
	} catch (err) {
		if (err instanceof FileVersionConflictError) {
			return c.json(
				{
					...createApiError(
						'CONFLICT',
						'File changed since it was loaded',
						[
							{
								field: 'if_match',
								message: 'if_match does not match the current content hash',
								expected: err.currentHash,
								received: body.if_match,
							},
						],
						'Fetch the file again and decide whether to load the new version or overwrite it.',
					),
					currentHash: err.currentHash,
				},
				409,
			)
		}
		if (err instanceof FileEditError) {
			return c.json(
				createApiError(
					'VALIDATION_ERROR',
					err.message,
					err.editIndex !== undefined
						? [
								{
									field: `edits.${err.editIndex}.old`,
									message: err.reason === 'no_match' ? 'not found' : `found ${err.matches} times`,
									...(err.matches !== undefined ? { received: String(err.matches) } : {}),
								},
							]
						: undefined,
					'Nothing was written. Fix the edit and send it again.',
				),
				400,
			)
		}
		if (err instanceof FileSaveTimeoutError) {
			logger.warn('File save timed out; rolled back', { fileId: existing.id, stage: err.stage })
			c.header('Retry-After', '1')
			return c.json(
				createApiError('INTERNAL_ERROR', err.message, undefined, 'Retry the save.'),
				503,
			)
		}
		logger.error('File save failed', {
			fileId: existing.id,
			workspaceId: existing.workspaceId,
			error: String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to store file bytes'), 500)
	}

	if (!saved) {
		return c.json(createApiError('NOT_FOUND', 'File not found'), 404)
	}
	const updated = saved.row

	if (saved.contentChanged) {
		void trackFileSaved({
			workspaceId: updated.workspaceId,
			fileId: updated.id,
			actorId,
			actorType: c.get('actorType') === 'agent' ? 'agent' : 'human',
			fileType: updated.mimeType,
			sizeBytes: updated.sizeBytes,
		})
	}

	try {
		await recordEvent(db, {
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
				...(body.edits ? { editCount: body.edits.length } : {}),
			},
			provenance: {
				sessionId: producingSessionId(c.get('apiKeySessionId'), c.get('maskinSessionId')),
				entityKind: 'file',
			},
		})
	} catch (err) {
		logger.error('Failed to record file updated audit event', {
			workspaceId: updated.workspaceId,
			fileId: updated.id,
			error: String(err),
		})
	}

	if (isLargeFile(updated)) {
		try {
			return c.json(
				(await buildLargeFileResponse(storage, updated, frontendUrl)) as z.infer<
					typeof fileDetailSchema
				>,
				200,
			)
		} catch (err) {
			logger.error('Failed to presign file download', { fileId: updated.id, error: String(err) })
			return c.json(createApiError('INTERNAL_ERROR', 'Failed to create download URL'), 500)
		}
	}

	// Re-read latest bytes for the response so the caller sees the post-update content.
	let responseBytes: Buffer = newBytes ?? Buffer.alloc(0)
	let responseRow = updated
	const contentWritten = newBytes !== null || body.edits !== undefined
	if (!newBytes) {
		try {
			responseBytes = await storage.get(updated.storageKey)
			// Rows that predate the content hash get one now, so the caller always
			// gets a hash to echo as if_match.
			const contentHash = await ensureContentHash(db, updated, responseBytes)
			responseRow = { ...updated, contentHash }
		} catch (err) {
			logger.error('Failed to read file bytes after update', {
				fileId: updated.id,
				error: String(err),
			})
		}
	}

	return c.json(
		buildResponse(
			responseRow,
			responseBytes,
			frontendUrl,
			contentWritten
				? htmlViewerWarning(updated.mimeType, responseBytes.toString('utf8'))
				: undefined,
		) as z.infer<typeof fileDetailSchema>,
		200,
	)
}) as RouteHandler<typeof updateFileRoute, Env>)

// -- DELETE /:id — Delete file ------------------------------------------------

const deleteFileRoute = createRoute({
	method: 'delete',
	path: '/{id}',
	'x-viewer-policy': 'writer',
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
	if (!existing || !(await isWorkspaceWriter(db, actorId, existing.workspaceId))) {
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
		await recordEvent(db, {
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
			provenance: {
				sessionId: producingSessionId(c.get('apiKeySessionId'), c.get('maskinSessionId')),
				entityKind: 'file',
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

// -- Large files: direct-to-storage multipart upload --------------------------
// The bytes go browser → storage over presigned URLs; the API only hands out
// the URLs (start) and, once the parts are up, stitches and verifies (complete).

const uploadIdParamSchema = z.object({ id: z.string().uuid() })

const startUploadRoute = createRoute({
	method: 'post',
	path: '/uploads',
	'x-viewer-policy': 'writer',
	tags: ['Files'],
	summary: 'Start a direct-to-storage upload of a large file',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: startFileUploadSchema } } },
	},
	responses: {
		201: {
			content: { 'application/json': { schema: fileUploadSessionSchema } },
			description: 'Upload started; PUT each part to its URL, then complete the upload',
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

app.openapi(startUploadRoute, (async (c) => {
	const db = c.get('db')
	const storage = c.get('storageProvider')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const body = c.req.valid('json')

	const fileId = randomUUID()
	const storageKey = fileStorageKey(workspaceId, fileId)
	const { partSize, partCount } = planFileUploadParts(body.size_bytes)
	const expiresAt = new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000)

	let s3UploadId: string | undefined
	try {
		s3UploadId = await storage.createMultipartUpload(storageKey, { contentType: body.mime_type })
		const uploadId = s3UploadId
		const urls = await Promise.all(
			Array.from({ length: partCount }, (_, i) =>
				storage.presignUploadPart(storageKey, uploadId, i + 1, UPLOAD_TTL_SECONDS),
			),
		)
		const [upload] = await db
			.insert(fileUploads)
			.values({
				workspaceId,
				fileId,
				name: body.name,
				description: body.description ?? null,
				kind: body.kind ?? null,
				tags: body.tags ?? [],
				mimeType: body.mime_type,
				sizeBytes: body.size_bytes,
				storageKey,
				s3UploadId: uploadId,
				partSize,
				partCount,
				createdBy: actorId,
				expiresAt,
			})
			.returning()
		if (!upload) throw new Error('Insert returned no row')
		return c.json(
			{
				upload_id: upload.id,
				file_id: fileId,
				part_size: partSize,
				parts: urls.map((url, i) => ({ part_number: i + 1, url })),
				expires_at: expiresAt.toISOString(),
			},
			201,
		)
	} catch (err) {
		logger.error('Failed to start file upload', { workspaceId, fileId, error: String(err) })
		if (s3UploadId) {
			await storage.abortMultipartUpload(storageKey, s3UploadId).catch((abortErr) =>
				logger.error('Failed to abort a multipart upload that never got a row (parts left)', {
					fileId,
					storageKey,
					error: String(abortErr),
				}),
			)
		}
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to start upload'), 500)
	}
}) as RouteHandler<typeof startUploadRoute, Env>)

const completeUploadRoute = createRoute({
	method: 'post',
	path: '/uploads/{id}/complete',
	'x-viewer-policy': 'writer',
	tags: ['Files'],
	summary: 'Finish a direct-to-storage upload and create the file',
	request: {
		params: uploadIdParamSchema,
		body: { content: { 'application/json': { schema: completeFileUploadSchema } } },
	},
	responses: {
		201: {
			content: { 'application/json': { schema: fileDetailSchema } },
			description: 'File created',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'The uploaded parts do not match what was declared',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Upload not found',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Upload already finished, abandoned or expired',
		},
		500: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Internal server error',
		},
		503: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Storage is unavailable; the upload is intact and can be completed again',
		},
	},
})

/** Loads an upload the caller started and may still write to; null otherwise. */
async function findOwnUpload(db: Database, actorId: string, id: string) {
	const [upload] = await db.select().from(fileUploads).where(eq(fileUploads.id, id)).limit(1)
	if (!upload || upload.createdBy !== actorId) return null
	if (!(await isWorkspaceWriter(db, actorId, upload.workspaceId))) return null
	return upload
}

app.openapi(completeUploadRoute, (async (c) => {
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

	const upload = await findOwnUpload(db, actorId, id)
	if (!upload) return c.json(createApiError('NOT_FOUND', 'Upload not found'), 404)

	// Moves a claimed row on from `completing`. Conditional on that status so a
	// request that outlived its claim cannot overwrite what the reaper settled.
	// Resolves to whether the row was still ours, or null if the write itself failed.
	const setStatus = async (status: 'pending' | 'completed' | 'aborted') => {
		try {
			const rows = await db
				.update(fileUploads)
				.set({ status })
				.where(and(eq(fileUploads.id, upload.id), eq(fileUploads.status, 'completing')))
				.returning({ id: fileUploads.id })
			return rows.length > 0
		} catch (err) {
			logger.error('Failed to update file upload status', {
				uploadId: upload.id,
				status,
				error: String(err),
			})
			return null
		}
	}

	// Drops an upload whose stitched object can never become a file. The object goes
	// first: the reaper only revisits rows still `completing`, so marking the row
	// `aborted` before a failed delete would strand a billable orphan for good.
	const discardStitched = async () => {
		if (await deleteStoredObject(storage, upload)) await setStatus('aborted')
	}

	const respondWithFile = async (file: typeof files.$inferSelect) => {
		try {
			return c.json(
				(await buildLargeFileResponse(storage, file, frontendUrl)) as z.infer<
					typeof fileDetailSchema
				>,
				201,
			)
		} catch (err) {
			logger.error('Failed to presign file download', { fileId: file.id, error: String(err) })
			return c.json(createApiError('INTERNAL_ERROR', 'File saved but its download URL failed'), 500)
		}
	}

	// A retried complete (lost response) gets the file it already made. The file
	// row is the proof: a row stuck in `completing` whose file exists lost only
	// its final status write.
	if (upload.status === 'completed' || upload.status === 'completing') {
		const [existing] = await db.select().from(files).where(eq(files.id, upload.fileId)).limit(1)
		if (existing) {
			if (upload.status === 'completing') await setStatus('completed')
			return respondWithFile(existing)
		}
		if (upload.status === 'completing') {
			return c.json(createApiError('CONFLICT', 'This upload is already being completed'), 409)
		}
	}
	if (upload.status !== 'pending') {
		return c.json(createApiError('CONFLICT', 'This upload is no longer open'), 409)
	}
	if (upload.expiresAt.getTime() < Date.now()) {
		return c.json(createApiError('CONFLICT', 'This upload expired; start a new one'), 409)
	}

	// Every part, exactly once.
	const numbers = new Set(body.parts.map((p) => p.part_number))
	const allParts =
		body.parts.length === upload.partCount &&
		numbers.size === upload.partCount &&
		Array.from({ length: upload.partCount }, (_, i) => i + 1).every((n) => numbers.has(n))
	if (!allParts) {
		return c.json(
			createApiError('VALIDATION_ERROR', `Expected ${upload.partCount} parts, numbered from 1`),
			400,
		)
	}

	// Claim it so two completes cannot both stitch the object.
	// The row stays `completing` until the file row exists, never `completed`
	// before: a request that dies in between leaves a row the reaper can settle,
	// not a finished-looking upload with no file behind it.
	const [claimed] = await db
		.update(fileUploads)
		.set({ status: 'completing', claimedAt: new Date() })
		.where(and(eq(fileUploads.id, upload.id), eq(fileUploads.status, 'pending')))
		.returning({ id: fileUploads.id })
	if (!claimed) {
		return c.json(createApiError('CONFLICT', 'This upload is already being completed'), 409)
	}

	try {
		await storage.completeMultipartUpload(
			upload.storageKey,
			upload.s3UploadId,
			body.parts.map((p) => ({ partNumber: p.part_number, etag: p.etag })),
		)
	} catch (err) {
		const failure = classifyCompleteFailure(err)
		if (failure === 'bad_parts') {
			// Wrong or missing ETags leave the upload intact, so the client may retry.
			logger.warn('Storage rejected the uploaded parts', {
				uploadId: upload.id,
				error: String(err),
			})
			await setStatus('pending')
			return c.json(
				createApiError('VALIDATION_ERROR', 'Storage did not accept the uploaded parts'),
				400,
			)
		}
		if (failure === 'gone') {
			// A complete whose response was lost still stitched the object, so the retry
			// finds no multipart upload. If the object is there, carry on to the checks
			// below instead of reporting a finished upload as expired.
			const found = await storage.headObject(upload.storageKey).then(
				(o) => o,
				() => undefined,
			)
			if (found === undefined) {
				logger.error('Could not check for a stitched object', { uploadId: upload.id })
				await setStatus('pending')
				return c.json(createApiError('INTERNAL_ERROR', 'Storage is unavailable, try again'), 503)
			}
			if (found === null) {
				logger.warn('Storage no longer has the upload', {
					uploadId: upload.id,
					error: String(err),
				})
				await setStatus('aborted')
				return c.json(createApiError('CONFLICT', 'This upload expired; start a new one'), 409)
			}
			logger.warn('Upload was already stitched; finishing it', { uploadId: upload.id })
		} else {
			// Storage is down or unreachable: nothing is wrong with the request.
			logger.error('Storage failed while completing an upload', {
				uploadId: upload.id,
				error: String(err),
			})
			await setStatus('pending')
			return c.json(createApiError('INTERNAL_ERROR', 'Storage is unavailable, try again'), 503)
		}
	}

	// Trust the stored object, not the declaration: it is what readers will get.
	let stored: { size: number } | null
	try {
		stored = await storage.headObject(upload.storageKey)
	} catch (err) {
		logger.error('Failed to read uploaded object', { uploadId: upload.id, error: String(err) })
		await discardStitched()
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to verify the upload'), 500)
	}
	if (!stored || stored.size !== upload.sizeBytes) {
		await discardStitched()
		return c.json(
			createApiError('VALIDATION_ERROR', 'Uploaded size does not match the declared size'),
			400,
		)
	}

	let created: typeof files.$inferSelect | undefined
	try {
		created = await insertStoredFile(db, {
			id: upload.fileId,
			workspaceId: upload.workspaceId,
			name: upload.name,
			description: upload.description,
			kind: upload.kind,
			tags: upload.tags,
			mimeType: upload.mimeType,
			sizeBytes: stored.size,
			storageKey: upload.storageKey,
			// Not hashed: that would mean reading the whole object back. Large files
			// cannot be edited, so nothing compares against a hash.
			contentHash: null,
			createdBy: actorId,
		})
	} catch (err) {
		logger.error('Failed to create file row for finished upload', {
			uploadId: upload.id,
			error: String(err),
		})
		await discardStitched()
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create file'), 500)
	}

	// The file exists now; only then is the upload finished. If this write fails the
	// row stays `completing` and a retried complete or the reaper settles it.
	if ((await setStatus('completed')) === false) {
		// The claim went stale mid-request and the reaper settled the row. Unless it
		// found the file and completed it, it also deleted the object: undo the file.
		const [current] = await db
			.select({ status: fileUploads.status })
			.from(fileUploads)
			.where(eq(fileUploads.id, upload.id))
			.limit(1)
		if (current?.status !== 'completed') {
			logger.error('Upload was settled while its complete was running', { uploadId: upload.id })
			await db
				.delete(files)
				.where(eq(files.id, created.id))
				.catch((err) =>
					logger.error('Failed to remove a file whose upload was reaped', {
						fileId: created?.id,
						error: String(err),
					}),
				)
			await deleteStoredObject(storage, upload)
			return c.json(createApiError('CONFLICT', 'This upload expired; start a new one'), 409)
		}
	}

	try {
		await recordFileCreated(db, {
			file: created,
			actorId,
			sessionId: producingSessionId(c.get('apiKeySessionId'), c.get('maskinSessionId')),
		})
	} catch (err) {
		logger.error('Failed to record file created audit event', {
			workspaceId: created.workspaceId,
			fileId: created.id,
			error: String(err),
		})
	}

	return respondWithFile(created)
}) as RouteHandler<typeof completeUploadRoute, Env>)

const abortUploadRoute = createRoute({
	method: 'delete',
	path: '/uploads/{id}',
	'x-viewer-policy': 'writer',
	tags: ['Files'],
	summary: 'Abandon a direct-to-storage upload',
	request: { params: uploadIdParamSchema },
	responses: {
		200: {
			content: { 'application/json': { schema: z.object({ aborted: z.boolean() }) } },
			description: 'Upload abandoned; its stored parts are discarded',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Upload not found',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Upload already finished or being finished',
		},
		500: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Storage could not discard the parts; the upload stays open to be reclaimed',
		},
	},
})

app.openapi(abortUploadRoute, (async (c) => {
	const db = c.get('db')
	const storage = c.get('storageProvider')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	const upload = await findOwnUpload(db, actorId, id)
	if (!upload) return c.json(createApiError('NOT_FOUND', 'Upload not found'), 404)
	if (upload.status === 'completed' || upload.status === 'completing') {
		return c.json(createApiError('CONFLICT', 'This upload is already finished'), 409)
	}

	const [claimed] = await db
		.update(fileUploads)
		.set({ status: 'aborted' })
		.where(and(eq(fileUploads.id, upload.id), eq(fileUploads.status, 'pending')))
		.returning({ id: fileUploads.id })
	if (claimed) {
		try {
			await abortStoredUpload(storage, upload)
		} catch (err) {
			// Reopen the row instead of reporting an abort that did not happen: once it
			// expires, the reaper retries the discard.
			logger.error('Failed to abort multipart upload in storage', {
				uploadId: upload.id,
				error: String(err),
			})
			await db
				.update(fileUploads)
				.set({ status: 'pending' })
				.where(and(eq(fileUploads.id, upload.id), eq(fileUploads.status, 'aborted')))
				.catch((revertErr) =>
					logger.error('Failed to reopen an upload whose abort failed (parts left)', {
						uploadId: upload.id,
						error: String(revertErr),
					}),
				)
			return c.json(createApiError('INTERNAL_ERROR', 'Could not discard the upload'), 500)
		}
	}
	return c.json({ aborted: true }, 200)
}) as RouteHandler<typeof abortUploadRoute, Env>)

export default app
