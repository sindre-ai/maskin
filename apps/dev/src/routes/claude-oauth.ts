import type { Database } from '@ai-native/db'
import { workspaceMembers, workspaces } from '@ai-native/db/schema'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import { and, eq } from 'drizzle-orm'
import {
	type ClaudeOAuthTokens,
	type EncryptedOAuthData,
	encryptOAuthTokens,
	getValidOAuthToken,
} from '../lib/claude-oauth'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'

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

// ── DELETE /api/claude-oauth ────────────────────────────────────────────────

const disconnectRoute = createRoute({
	method: 'delete',
	path: '/',
	tags: ['claude-oauth'],
	summary: 'Disconnect Claude OAuth (remove stored tokens)',
	request: {
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			description: 'OAuth tokens removed',
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

app.openapi(disconnectRoute, (async (c) => {
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

	const settings = (ws.settings as Record<string, unknown>) ?? {}
	const { claude_oauth: _, ...rest } = settings

	await db
		.update(workspaces)
		.set({ settings: rest, updatedAt: new Date() })
		.where(eq(workspaces.id, workspaceId))

	logger.info('Claude OAuth disconnected for workspace', { workspaceId })
	return c.json({ success: true })
}) as RouteHandler<typeof disconnectRoute, Env>)

// ── GET /api/claude-oauth/status ────────────────────────────────────────────

const statusRoute = createRoute({
	method: 'get',
	path: '/status',
	tags: ['claude-oauth'],
	summary: 'Get Claude OAuth connection status',
	request: {
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			description: 'OAuth status',
			content: {
				'application/json': {
					schema: z.object({
						connected: z.boolean(),
						subscription_type: z.string().optional(),
						expires_at: z.number().optional(),
						valid: z.boolean(),
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
		return c.json({ connected: false, valid: false })
	}

	const settings = (ws.settings as Record<string, unknown>) ?? {}
	const oauthData = settings.claude_oauth as EncryptedOAuthData | undefined

	if (!oauthData) {
		return c.json({ connected: false, valid: false })
	}

	// Try refresh via the shared helper (handles decrypt → refresh → persist)
	try {
		const result = await getValidOAuthToken(db, workspaceId, 0)
		if (result) {
			return c.json({
				connected: true,
				subscription_type: result.tokens.subscriptionType,
				expires_at: result.tokens.expiresAt,
				valid: true,
			})
		}
	} catch {
		// Refresh failed — report as connected but invalid
	}

	return c.json({
		connected: true,
		subscription_type: oauthData.subscriptionType,
		expires_at: oauthData.expiresAt,
		valid: false,
	})
}) as RouteHandler<typeof statusRoute, Env>)

// ── POST /api/claude-oauth/import ───────────────────────────────────────────
// Accept raw tokens directly (from credentials.json paste)

const importRoute = createRoute({
	method: 'post',
	path: '/import',
	tags: ['claude-oauth'],
	summary: 'Import Claude OAuth tokens from credentials.json',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': {
					schema: z.object({
						accessToken: z.string().min(1),
						refreshToken: z.string().min(1),
						expiresAt: z.number(),
						subscriptionType: z.string().optional(),
						scopes: z.array(z.string()).optional(),
					}),
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Tokens imported and stored',
			content: {
				'application/json': {
					schema: z.object({
						success: z.boolean(),
						subscription_type: z.string().optional(),
						expires_at: z.number(),
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

app.openapi(importRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const member = await requireWorkspaceMember(db, workspaceId, actorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const tokens: ClaudeOAuthTokens = c.req.valid('json')

	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	if (!ws) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	const settings = (ws.settings as Record<string, unknown>) ?? {}
	await db
		.update(workspaces)
		.set({
			settings: { ...settings, claude_oauth: encryptOAuthTokens(tokens) },
			updatedAt: new Date(),
		})
		.where(eq(workspaces.id, workspaceId))

	logger.info('Claude OAuth tokens imported for workspace', {
		workspaceId,
		subscriptionType: tokens.subscriptionType,
	})

	return c.json({
		success: true,
		subscription_type: tokens.subscriptionType,
		expires_at: tokens.expiresAt,
	})
}) as RouteHandler<typeof importRoute, Env>)

export default app
