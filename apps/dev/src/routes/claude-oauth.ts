import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { Database } from '@ai-native/db'
import { workspaceMembers, workspaces } from '@ai-native/db/schema'
import { CLAUDE_AUTHORIZE_URL, CLAUDE_OAUTH_CLIENT_ID } from '@ai-native/shared'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import { and, eq } from 'drizzle-orm'
import {
	type ClaudeOAuthTokens,
	type EncryptedOAuthData,
	encryptOAuthTokens,
	exchangeCodeForTokens,
	getValidOAuthToken,
} from '../lib/claude-oauth'
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

// ── POST /api/claude-oauth/exchange ─────────────────────────────────────────

const exchangeRoute = createRoute({
	method: 'post',
	path: '/exchange',
	tags: ['claude-oauth'],
	summary: 'Exchange authorization code for Claude OAuth tokens',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': {
					schema: z.object({
						code: z.string().min(1),
						code_verifier: z.string().min(1),
						redirect_uri: z.string().url(),
						state: z.string().min(1),
					}),
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Tokens exchanged and stored',
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
		400: {
			description: 'Token exchange failed',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Not a workspace member',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(exchangeRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { code, code_verifier, redirect_uri, state } = c.req.valid('json')

	const member = await requireWorkspaceMember(db, workspaceId, actorId)
	if (!member) {
		return c.json({ error: 'Not a member of this workspace' }, 403)
	}

	// Validate state matches what we expect (stored encrypted in session)
	const expectedState = c.req.header('X-OAuth-State')
	if (expectedState && expectedState !== state) {
		return c.json({ error: 'OAuth state mismatch — possible CSRF attack' }, 400)
	}

	let tokens: import('../lib/claude-oauth').ClaudeOAuthTokens
	try {
		tokens = await exchangeCodeForTokens(code, code_verifier, redirect_uri)
	} catch (err) {
		logger.error('Claude OAuth token exchange failed', { error: String(err) })
		return c.json({ error: `Token exchange failed: ${String(err)}` }, 400)
	}

	// Store encrypted tokens in workspace settings
	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	if (!ws) {
		return c.json({ error: 'Workspace not found' }, 400)
	}

	const settings = (ws.settings as Record<string, unknown>) ?? {}

	await db
		.update(workspaces)
		.set({
			settings: { ...settings, claude_oauth: encryptOAuthTokens(tokens) },
			updatedAt: new Date(),
		})
		.where(eq(workspaces.id, workspaceId))

	logger.info('Claude OAuth tokens stored for workspace', {
		workspaceId,
		subscriptionType: tokens.subscriptionType,
	})

	return c.json({
		success: true,
		subscription_type: tokens.subscriptionType,
		expires_at: tokens.expiresAt,
	})
}) as RouteHandler<typeof exchangeRoute, Env>)

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
		return c.json({ error: 'Not a member of this workspace' }, 403)
	}

	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	if (!ws) {
		return c.json({ error: 'Workspace not found' }, 400)
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
		return c.json({ error: 'Not a member of this workspace' }, 403)
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
		return c.json({ error: 'Not a member of this workspace' }, 403)
	}

	const tokens: ClaudeOAuthTokens = c.req.valid('json')

	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	if (!ws) {
		return c.json({ error: 'Workspace not found' }, 400)
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

// ── POST /api/claude-oauth/start ────────────────────────────────────────────
// Start a localhost OAuth flow: spin up a temp HTTP server, return the auth URL.
// The temp server waits for the OAuth callback, exchanges the code, stores tokens.

const pendingFlows = new Map<
	string,
	{ status: 'pending' | 'complete' | 'error'; error?: string; server: import('node:http').Server }
>()

const startRoute = createRoute({
	method: 'post',
	path: '/start',
	tags: ['claude-oauth'],
	summary: 'Start localhost OAuth flow (opens browser for login)',
	request: {
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			description: 'OAuth URL to open in browser',
			content: {
				'application/json': {
					schema: z.object({
						auth_url: z.string(),
						flow_id: z.string(),
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

app.openapi(startRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const member = await requireWorkspaceMember(db, workspaceId, actorId)
	if (!member) {
		return c.json({ error: 'Not a member of this workspace' }, 403)
	}

	// Generate PKCE pair
	const codeVerifier = randomBytes(32).toString('base64url')
	const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
	const state = randomBytes(16).toString('base64url')
	const flowId = randomBytes(8).toString('hex')

	// Start a temporary HTTP server on a random port
	const server = createServer()

	const port = await new Promise<number>((resolve, reject) => {
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address()
			if (addr && typeof addr === 'object') {
				resolve(addr.port)
			} else {
				reject(new Error('Failed to get server address'))
			}
		})
	})

	const redirectUri = `http://localhost:${port}/callback`

	// Build the authorize URL
	const params = new URLSearchParams({
		code: 'true',
		client_id: CLAUDE_OAUTH_CLIENT_ID,
		response_type: 'code',
		redirect_uri: redirectUri,
		scope:
			'user:inference user:profile user:file_upload user:mcp_servers user:sessions:claude_code',
		code_challenge: codeChallenge,
		code_challenge_method: 'S256',
		state,
	})
	const authUrl = `${CLAUDE_AUTHORIZE_URL}?${params.toString()}`

	pendingFlows.set(flowId, { status: 'pending', server })

	// Handle the callback
	server.on('request', async (req, res) => {
		const url = new URL(req.url ?? '/', `http://localhost:${port}`)
		if (url.pathname !== '/callback') {
			res.writeHead(404)
			res.end('Not found')
			return
		}

		const code = url.searchParams.get('code')
		const returnedState = url.searchParams.get('state')

		if (!code || returnedState !== state) {
			res.writeHead(400)
			res.end('Invalid callback: missing code or state mismatch')
			pendingFlows.set(flowId, { status: 'error', error: 'State mismatch', server })
			server.close()
			return
		}

		try {
			const tokens = await exchangeCodeForTokens(code, codeVerifier, redirectUri)
			const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
			if (ws) {
				const settings = (ws.settings as Record<string, unknown>) ?? {}
				await db
					.update(workspaces)
					.set({
						settings: { ...settings, claude_oauth: encryptOAuthTokens(tokens) },
						updatedAt: new Date(),
					})
					.where(eq(workspaces.id, workspaceId))
			}

			pendingFlows.set(flowId, { status: 'complete', server })
			logger.info('Claude OAuth completed via localhost flow', {
				workspaceId,
				subscriptionType: tokens.subscriptionType,
			})

			// Show a success page and close the tab
			res.writeHead(200, { 'Content-Type': 'text/html' })
			res.end(`<!DOCTYPE html><html><head><title>Connected</title></head><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
				<div style="text-align:center"><h2>Connected to Claude</h2><p>You can close this window.</p>
				<script>window.close()</script></div></body></html>`)
		} catch (err) {
			logger.error('Claude OAuth localhost flow failed', { error: String(err) })
			pendingFlows.set(flowId, { status: 'error', error: 'Authentication failed', server })
			res.writeHead(500)
			res.end('Authentication failed. Please try again.')
		}

		server.close()
	})

	// Auto-cleanup after 5 minutes
	setTimeout(
		() => {
			const flow = pendingFlows.get(flowId)
			if (flow) {
				if (flow.status === 'pending') {
					flow.server.close()
				}
				pendingFlows.delete(flowId)
			}
		},
		5 * 60 * 1000,
	)

	return c.json({ auth_url: authUrl, flow_id: flowId })
}) as RouteHandler<typeof startRoute, Env>)

// ── GET /api/claude-oauth/flow/:flowId ──────────────────────────────────────
// Poll the status of a localhost OAuth flow

const flowStatusRoute = createRoute({
	method: 'get',
	path: '/flow/{flowId}',
	tags: ['claude-oauth'],
	summary: 'Check localhost OAuth flow status',
	request: {
		params: z.object({ flowId: z.string() }),
	},
	responses: {
		200: {
			description: 'Flow status',
			content: {
				'application/json': {
					schema: z.object({
						status: z.enum(['pending', 'complete', 'error']),
						error: z.string().optional(),
					}),
				},
			},
		},
	},
})

app.openapi(flowStatusRoute, (async (c) => {
	const { flowId } = c.req.valid('param')
	const flow = pendingFlows.get(flowId)

	if (!flow) {
		return c.json({ status: 'error' as const, error: 'Flow not found or expired' })
	}

	const result = { status: flow.status, error: flow.error }

	// Clean up completed/errored flows
	if (flow.status !== 'pending') {
		pendingFlows.delete(flowId)
	}

	return c.json(result)
}) as RouteHandler<typeof flowStatusRoute, Env>)

export default app
