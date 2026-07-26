// Server-side avatar upload for agents. Accepts a PNG or JPEG multipart upload,
// downsizes to a 256×256 square (cover-fit) with sharp, writes the transformed
// bytes to S3 at `workspaces/{workspaceId}/avatars/{actorId}.{ext}`, and PATCHes
// the actor's avatar_url with a public serving URL. The bucket stays private —
// the sibling GET /:id/avatar route proxies the object so the stored URL is a
// direct, no-auth image URL (satisfies the T5 DoD constraint of "no signed URLs").

import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { actors, workspaceMembers } from '@maskin/db/schema'
import { actorResponseSchema } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import sharp from 'sharp'
import { createApiError } from '../lib/errors'
import { actorAvatarStorageKey, actorAvatarUrl } from '../lib/file-urls'
import { logger } from '../lib/logger'
import { errorSchema, idParamSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import { isWorkspaceMember } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		storageProvider: StorageProvider
	}
}

const MAX_AVATAR_BYTES = 2 * 1024 * 1024
const AVATAR_SIZE_PX = 256
const JPEG_QUALITY = 80
const ALLOWED_MIME = ['image/png', 'image/jpeg'] as const
type AvatarMime = (typeof ALLOWED_MIME)[number]

function extForMime(mime: AvatarMime): 'png' | 'jpg' {
	return mime === 'image/png' ? 'png' : 'jpg'
}

async function downsize(input: Buffer, mime: AvatarMime): Promise<Buffer> {
	const pipeline = sharp(input).rotate().resize(AVATAR_SIZE_PX, AVATAR_SIZE_PX, {
		fit: 'cover',
		position: 'centre',
	})
	if (mime === 'image/png') return pipeline.png().toBuffer()
	return pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer()
}

const app = new OpenAPIHono<Env>()

// -- POST /:id/avatar — Upload avatar for an actor ---------------------------

// Fast-reject on Content-Length before OpenAPI's form-body validator buffers
// the payload. Registered as a plain middleware so it runs ahead of the
// generated zValidator("form", ...) chain — the handler-level check runs too
// late for oversized bodies because parseBody() would already have streamed
// them into memory. `Content-Length` can be spoofed or absent, so the
// post-buffer `file.size` check in the handler stays as the source of truth.
app.use('/:id/avatar', async (c, next) => {
	if (c.req.method !== 'POST') return next()
	const contentLengthRaw = c.req.header('content-length')
	if (contentLengthRaw) {
		const contentLength = Number(contentLengthRaw)
		if (Number.isFinite(contentLength) && contentLength > MAX_AVATAR_BYTES) {
			return c.json(createApiError('BAD_REQUEST', 'Avatar must be 2MB or smaller'), 413)
		}
	}
	await next()
})

const uploadAvatarRoute = createRoute({
	method: 'post',
	path: '/{id}/avatar',
	tags: ['Actors'],
	summary: 'Upload an avatar image for an actor',
	request: {
		params: idParamSchema,
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
		200: {
			content: { 'application/json': { schema: actorResponseSchema } },
			description: 'Avatar uploaded and actor updated',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Only workspace admins can upload avatars',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found in workspace',
		},
		413: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Uploaded file exceeds 2MB',
		},
		415: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Unsupported file type — PNG or JPEG only',
		},
	},
})

app.openapi(uploadAvatarRoute, (async (c) => {
	const db = c.get('db')
	const storage = c.get('storageProvider')
	const callerActorId = c.get('actorId')
	const { id: targetActorId } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	// Admin gate — owner or admin membership on the given workspace.
	const [callerMembership] = await db
		.select({ role: workspaceMembers.role })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(workspaceMembers.actorId, callerActorId),
			),
		)
		.limit(1)

	if (!callerMembership || !['owner', 'admin'].includes(callerMembership.role)) {
		return c.json(createApiError('FORBIDDEN', 'Only workspace admins can upload avatars'), 403)
	}

	// Target actor must exist and belong to this workspace — 404 leak-proof
	// (an admin in workspace A can't probe actors in workspace B).
	if (!(await isWorkspaceMember(db, targetActorId, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	let formData: FormData
	try {
		formData = await c.req.formData()
	} catch (err) {
		logger.warn('Failed to parse avatar multipart body', { error: String(err) })
		return c.json(createApiError('BAD_REQUEST', 'Invalid multipart body'), 400)
	}
	const file = formData.get('file')
	if (!file || !(file instanceof File)) {
		return c.json(createApiError('BAD_REQUEST', 'No file provided'), 400)
	}

	if (file.size > MAX_AVATAR_BYTES) {
		return c.json(createApiError('BAD_REQUEST', 'Avatar must be 2MB or smaller'), 413)
	}

	const mime = file.type
	if (!ALLOWED_MIME.includes(mime as AvatarMime)) {
		return c.json(createApiError('BAD_REQUEST', 'Avatar must be a PNG or JPEG image'), 415)
	}
	const avatarMime = mime as AvatarMime

	const input = Buffer.from(await file.arrayBuffer())
	let transformed: Buffer
	try {
		transformed = await downsize(input, avatarMime)
	} catch (err) {
		logger.warn('sharp failed to decode/resize avatar', {
			actorId: targetActorId,
			workspaceId,
			error: String(err),
		})
		return c.json(createApiError('BAD_REQUEST', 'Could not decode image'), 400)
	}

	const ext = extForMime(avatarMime)
	const storageKey = actorAvatarStorageKey(workspaceId, targetActorId, ext)

	try {
		await storage.put(storageKey, transformed)
	} catch (err) {
		logger.error('S3 put failed for actor avatar', {
			actorId: targetActorId,
			workspaceId,
			storageKey,
			error: String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to store avatar'), 500)
	}

	// Cache-bust re-uploads: same S3 key + updated URL query so the CDN/browser
	// doesn't keep serving the previous image after a fresh upload.
	const updatedAt = new Date()
	const avatarUrl = actorAvatarUrl(workspaceId, targetActorId, updatedAt.getTime())

	const [updated] = await db
		.update(actors)
		.set({
			avatarUrl,
			updatedAt,
		})
		.where(eq(actors.id, targetActorId))
		.returning({
			id: actors.id,
			type: actors.type,
			name: actors.name,
			email: actors.email,
			description: actors.description,
			system_prompt: actors.systemPrompt,
			tools: actors.tools,
			memory: actors.memory,
			llm_provider: actors.llmProvider,
			llm_config: actors.llmConfig,
			avatar_url: actors.avatarUrl,
			isSystem: actors.isSystem,
			agentState: actors.agentState,
			agentStateUpdatedAt: actors.agentStateUpdatedAt,
			createdAt: actors.createdAt,
			updatedAt: actors.updatedAt,
		})

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	return c.json(serialize(updated) as z.infer<typeof actorResponseSchema>, 200)
}) as RouteHandler<typeof uploadAvatarRoute, Env>)

// -- GET /:id/avatar — Public proxy that serves the stored image bytes -------
// No auth: the URL is meant to be dropped into <img src=…> tags in comment
// feeds and notification cards. The bucket itself stays private; this proxy is
// the sanctioned public read path. Kept off the OpenAPI surface (plain
// `app.get`) because the response is raw bytes, not a JSON schema.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

app.get('/:id/avatar', async (c) => {
	const db = c.get('db')
	const storage = c.get('storageProvider')
	const targetActorId = c.req.param('id')

	if (!UUID_RE.test(targetActorId)) {
		return c.json(createApiError('BAD_REQUEST', 'Invalid actor id'), 400)
	}

	// The S3 prefix is workspace-scoped, and an agent can live in more than one
	// workspace (Sindre by design). `ws` pins the prefix — actorAvatarUrl() bakes
	// it in on write so we don't have to guess a membership row here.
	const workspaceId = c.req.query('ws')
	if (!workspaceId || !UUID_RE.test(workspaceId)) {
		return c.json(createApiError('BAD_REQUEST', 'Missing or invalid ws query parameter'), 400)
	}

	const [actor] = await db
		.select({ id: actors.id, avatarUrl: actors.avatarUrl })
		.from(actors)
		.where(eq(actors.id, targetActorId))
		.limit(1)

	if (!actor?.avatarUrl) {
		return c.json(createApiError('NOT_FOUND', 'Avatar not found'), 404)
	}

	// Try PNG first, then JPG — the stored extension isn't recorded in the DB.
	// Cheap: exists() is a HEAD; the fallback is one more HEAD.
	const pngKey = actorAvatarStorageKey(workspaceId, targetActorId, 'png')
	const jpgKey = actorAvatarStorageKey(workspaceId, targetActorId, 'jpg')
	let bytes: Buffer | null = null
	let contentType: 'image/png' | 'image/jpeg' | null = null
	if (await storage.exists(pngKey)) {
		bytes = await storage.get(pngKey)
		contentType = 'image/png'
	} else if (await storage.exists(jpgKey)) {
		bytes = await storage.get(jpgKey)
		contentType = 'image/jpeg'
	}

	if (!bytes || !contentType) {
		return c.json(createApiError('NOT_FOUND', 'Avatar not found'), 404)
	}

	c.header('Content-Type', contentType)
	c.header('Cache-Control', 'public, max-age=300')
	return c.body(new Uint8Array(bytes))
})

export default app
