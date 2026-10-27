import { randomUUID } from 'node:crypto'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { actors } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq, sql } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, idParamSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { actorsShareWorkspace, isAdminOfSharedWorkspace } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		storageProvider: StorageProvider
	}
}

const MAX_AVATAR_BYTES = 2 * 1024 * 1024

const avatarKey = (actorId: string, version: string) => `avatars/${actorId}/${version}`

/** Sniffed from the bytes, not the client-sent type, so the served type can be trusted. */
function sniffImageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | null {
	const isPng =
		bytes.length > 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	if (isPng) return 'image/png'
	const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
	return isJpeg ? 'image/jpeg' : null
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// POST /:id/avatar - Upload or replace an actor's profile picture
const uploadAvatarRoute = createRoute({
	method: 'post',
	path: '/{id}/avatar',
	'x-viewer-policy': 'writer',
	tags: ['Actors'],
	summary: 'Upload an actor avatar (PNG or JPG, up to 2 MB)',
	request: {
		params: idParamSchema,
		headers: workspaceIdHeader,
		body: {
			content: {
				'multipart/form-data': {
					schema: z.object({ file: z.any().openapi({ type: 'string', format: 'binary' }) }),
				},
			},
		},
	},
	responses: {
		200: {
			content: {
				'application/json': { schema: z.object({ id: z.string().uuid(), avatar_url: z.string() }) },
			},
			description: 'Avatar stored',
		},
		400: { content: { 'application/json': { schema: errorSchema } }, description: 'No file' },
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Caller is not a workspace admin or owner',
		},
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
		413: { content: { 'application/json': { schema: errorSchema } }, description: 'Over 2 MB' },
		415: { content: { 'application/json': { schema: errorSchema } }, description: 'Not PNG/JPG' },
	},
})

app.openapi(uploadAvatarRoute, (async (c) => {
	const db = c.get('db')
	const storage = c.get('storageProvider')
	const callerId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	if (!(await actorsShareWorkspace(db, callerId, id, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}
	if (!(await isAdminOfSharedWorkspace(db, callerId, id, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Only workspace admins can upload avatars'), 403)
	}

	const [target] = await db
		.select({ type: actors.type, metadata: actors.metadata })
		.from(actors)
		.where(eq(actors.id, id))
		.limit(1)
	if (target?.type !== 'agent') {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	// Refuse an oversized body before reading it. The multipart envelope adds a few hundred bytes.
	if (Number(c.req.header('content-length')) > MAX_AVATAR_BYTES + 4096) {
		return c.json(createApiError('BAD_REQUEST', 'Image is too large. Maximum is 2 MB.'), 413)
	}

	const file = (await c.req.formData()).get('file')
	if (!(file instanceof File)) {
		return c.json(createApiError('BAD_REQUEST', 'No file provided'), 400)
	}
	if (file.size > MAX_AVATAR_BYTES) {
		return c.json(createApiError('BAD_REQUEST', 'Image is too large. Maximum is 2 MB.'), 413)
	}
	const bytes = new Uint8Array(await file.arrayBuffer())
	const contentType = sniffImageType(bytes)
	if (!contentType) {
		return c.json(createApiError('BAD_REQUEST', 'Upload a PNG or JPG image.'), 415)
	}

	const previousVersion = (target.metadata as { avatar_version?: string } | null)?.avatar_version

	const version = randomUUID()
	await storage.put(avatarKey(id, version), bytes)
	await db
		.update(actors)
		.set({
			metadata: sql`COALESCE(${actors.metadata}, '{}'::jsonb) || ${JSON.stringify({
				avatar_version: version,
				avatar_content_type: contentType,
			})}::jsonb`,
			updatedAt: new Date(),
		})
		.where(eq(actors.id, id))

	if (previousVersion) {
		try {
			await storage.delete(avatarKey(id, previousVersion))
		} catch (err) {
			logger.error('Failed to delete replaced avatar (orphan object left)', {
				actorId: id,
				error: String(err),
			})
		}
	}

	return c.json({ id, avatar_url: `/api/actors/${id}/avatar?v=${version}` }, 200)
}) as RouteHandler<typeof uploadAvatarRoute, Env>)

// GET /:id/avatar - Serve an agent's picture. Public (see the auth bypass in app-factory):
// an <img> tag cannot send an API key. Agents only, since human photos are personal data.
// ?v= changes on every upload, so the response is cached forever.
const getAvatarRoute = createRoute({
	method: 'get',
	path: '/{id}/avatar',
	tags: ['Actors'],
	summary: "Get an actor's avatar image",
	request: { params: idParamSchema },
	responses: {
		200: { description: 'Image bytes (PNG or JPEG)' },
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'No avatar' },
	},
})

app.openapi(getAvatarRoute, (async (c) => {
	const db = c.get('db')
	const storage = c.get('storageProvider')
	const { id } = c.req.valid('param')

	const [row] = await db
		.select({ type: actors.type, metadata: actors.metadata })
		.from(actors)
		.where(eq(actors.id, id))
		.limit(1)
	const meta = row?.metadata as { avatar_version?: string; avatar_content_type?: string } | null
	// Public route: a human, a missing actor and an agent without a picture all answer the same 404.
	if (row?.type !== 'agent' || !meta?.avatar_version) {
		return c.json(createApiError('NOT_FOUND', 'No avatar'), 404)
	}

	const etag = `"${meta.avatar_version}"`
	if (c.req.header('if-none-match') === etag) {
		return c.body(null, 304, { ETag: etag })
	}

	let bytes: Buffer
	try {
		bytes = await storage.get(avatarKey(id, meta.avatar_version))
	} catch (err) {
		logger.error('Failed to read avatar from storage', { actorId: id, error: String(err) })
		return c.json(createApiError('NOT_FOUND', 'No avatar'), 404)
	}

	return c.body(new Uint8Array(bytes), 200, {
		'Content-Type': meta.avatar_content_type === 'image/png' ? 'image/png' : 'image/jpeg',
		'Cache-Control': 'public, max-age=31536000, immutable',
		ETag: etag,
		'X-Content-Type-Options': 'nosniff',
		'Content-Security-Policy': "default-src 'none'; sandbox",
	})
}) as RouteHandler<typeof getAvatarRoute, Env>)

export default app
