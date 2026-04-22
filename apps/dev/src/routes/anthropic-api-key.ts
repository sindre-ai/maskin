import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { workspaceMembers, workspaces } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import {
	type EncryptedAnthropicApiKey,
	encryptAnthropicApiKey,
	validateAnthropicApiKey,
} from '../lib/anthropic-api-key'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import type { WorkspaceSettings } from '../lib/types'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

async function requireWorkspaceMember(db: Database, workspaceId: string, actorId: string) {
	const [member] = await db
		.select()
		.from(workspaceMembers)
		.where(
			and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.actorId, actorId)),
		)
		.limit(1)
	return member ?? null
}

// ── GET /api/anthropic-api-key/status ───────────────────────────────────────

const statusRoute = createRoute({
	method: 'get',
	path: '/status',
	tags: ['anthropic-api-key'],
	summary: 'Get Anthropic API key status (never returns the full key)',
	request: {
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			description: 'Key status',
			content: {
				'application/json': {
					schema: z.object({
						set: z.boolean(),
						last4: z.string().optional(),
						created_at: z.number().optional(),
					}),
				},
			},
		},
		403: {
			description: 'Not a workspace member',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(statusRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const member = await requireWorkspaceMember(db, workspaceId, actorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	if (!ws) {
		return c.json({ set: false })
	}

	const settings = (ws.settings as WorkspaceSettings) ?? {}
	const data = settings.anthropic_api_key as EncryptedAnthropicApiKey | undefined
	if (!data?.encryptedKey) {
		return c.json({ set: false })
	}

	return c.json({
		set: true,
		last4: data.last4,
		created_at: data.createdAt,
	})
}) as RouteHandler<typeof statusRoute, Env>)

// ── POST /api/anthropic-api-key ─────────────────────────────────────────────

const saveRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['anthropic-api-key'],
	summary: 'Save (or replace) the workspace Anthropic API key',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': {
					schema: z.object({
						api_key: z.string().min(1),
					}),
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Key saved',
			content: {
				'application/json': {
					schema: z.object({
						success: z.boolean(),
						last4: z.string(),
						created_at: z.number(),
					}),
				},
			},
		},
		400: {
			description: 'Key validation failed',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Not a workspace member',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(saveRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const member = await requireWorkspaceMember(db, workspaceId, actorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const { api_key: apiKey } = c.req.valid('json')

	// Validate against Anthropic before persisting so we never store bad keys.
	const validation = await validateAnthropicApiKey(apiKey)
	if (!validation.ok) {
		return c.json(
			createApiError('BAD_REQUEST', validation.message ?? 'Anthropic API key validation failed'),
			400,
		)
	}

	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	if (!ws) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	const settings = (ws.settings as WorkspaceSettings) ?? {}
	const encrypted = encryptAnthropicApiKey(apiKey)

	// Also scrub any legacy plaintext copy from settings.llm_keys.anthropic so
	// the encrypted path is the single source of truth going forward.
	const { anthropic: _legacy, ...restLlmKeys } = settings.llm_keys ?? {}

	await db
		.update(workspaces)
		.set({
			settings: {
				...settings,
				llm_keys: restLlmKeys,
				anthropic_api_key: encrypted,
			},
			updatedAt: new Date(),
		})
		.where(eq(workspaces.id, workspaceId))

	logger.info('Anthropic API key saved for workspace', { workspaceId, last4: encrypted.last4 })

	return c.json({
		success: true,
		last4: encrypted.last4,
		created_at: encrypted.createdAt,
	})
}) as RouteHandler<typeof saveRoute, Env>)

// ── DELETE /api/anthropic-api-key ───────────────────────────────────────────

const deleteRoute = createRoute({
	method: 'delete',
	path: '/',
	tags: ['anthropic-api-key'],
	summary: 'Remove the workspace Anthropic API key',
	request: {
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			description: 'Key removed',
			content: {
				'application/json': {
					schema: z.object({ success: z.boolean() }),
				},
			},
		},
		403: {
			description: 'Not a workspace member',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(deleteRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const member = await requireWorkspaceMember(db, workspaceId, actorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	if (!ws) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	const settings = (ws.settings as WorkspaceSettings) ?? {}
	const { anthropic_api_key: _, ...rest } = settings

	await db
		.update(workspaces)
		.set({ settings: rest, updatedAt: new Date() })
		.where(eq(workspaces.id, workspaceId))

	logger.info('Anthropic API key removed for workspace', { workspaceId })
	return c.json({ success: true })
}) as RouteHandler<typeof deleteRoute, Env>)

export default app
