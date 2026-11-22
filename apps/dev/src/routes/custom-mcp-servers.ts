import { randomBytes, randomUUID } from 'node:crypto'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { agentGrants, integrations, sessions } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { setCookie } from 'hono/cookie'
import { restoreMaskedToolValues } from '../lib/actor-tools-redaction'
import { encrypt } from '../lib/crypto'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { resolveAgentAccess } from '../lib/integrations/agent-access'
import {
	CUSTOM_MCP_PROVIDER,
	type CustomMcpServer,
	customMcpServerSchema,
	isGatewayable,
	maskServer,
	readCustomServer,
	summarizeServer,
} from '../lib/integrations/custom-mcp'
import {
	KeychainReferenceError,
	credentialIndex,
	fillKeychainReferences,
	misplacedReferences,
	referencedVars,
} from '../lib/integrations/custom-mcp-keychain'
import {
	SignInError,
	blobForServer,
	getAccessToken,
	lockBlob,
	readSignIn,
	resolvesPublicly,
	signOut,
	startSignIn,
} from '../lib/integrations/custom-mcp-oauth'
import { sanitizeReturnPath } from '../lib/integrations/oauth/return-path'
import { encodeState } from '../lib/integrations/oauth/state'
import { errorSchema, idParamSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import {
	assertWorkspaceWriterRole,
	isWorkspaceHumanAdminOrOwner,
	isWorkspaceWriter,
} from '../lib/workspace-auth'
import {
	OAUTH_NONCE_COOKIE_MAX_AGE,
	oauthNonceCookieName,
	resolvePublicOrigin,
} from './integrations'
import { GatewayUpstreamError, proxyMcp } from './integrations-gateway'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		workspaceRole?: string
	}
}

// Custom MCP servers: a workspace's own tool servers, added by hand and shared with chosen
// agents through the same grants as an integration (PUT /api/integrations/:id/grants/:actorId).
// Each is one integrations row (provider 'custom-mcp'); the definition is the encrypted
// credentials blob and `config` carries only a summary every member may see. Removing one is
// DELETE /api/integrations/:id, like any integration.
const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const nameSchema = z.string().trim().min(1).max(60)

const serverResponseSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	// Env and header values come back as the mask; send the mask back to keep a value.
	server: customMcpServerSchema,
	// True once a person has signed in to the server in a browser and Maskin holds the token.
	signed_in: z.boolean().optional(),
})

const writeBodySchema = z.object({ name: nameSchema, server: customMcpServerSchema }).strict()

const errorResponses = {
	400: { description: 'Invalid', content: { 'application/json': { schema: errorSchema } } },
	403: { description: 'Not allowed', content: { 'application/json': { schema: errorSchema } } },
	404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
	409: { description: 'Name taken', content: { 'application/json': { schema: errorSchema } } },
}

function configFor(server: CustomMcpServer): Record<string, unknown> {
	return { custom_mcp: summarizeServer(server) }
}

async function nameTaken(
	db: Database,
	workspaceId: string,
	name: string,
	exceptId?: string,
): Promise<boolean> {
	const rows = await db
		.select({ id: integrations.id })
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, CUSTOM_MCP_PROVIDER),
				eq(integrations.status, 'active'),
				sql`lower(${integrations.displayName}) = ${name.toLowerCase()}`,
			),
		)
	return rows.some((r) => r.id !== exceptId)
}

async function loadRow(db: Database, workspaceId: string, id: string) {
	const [row] = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.id, id),
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, CUSTOM_MCP_PROVIDER),
				eq(integrations.status, 'active'),
			),
		)
		.limit(1)
	return row ?? null
}

function transportKey(server: CustomMcpServer): string {
	return JSON.stringify([
		server.type ?? null,
		server.command ?? null,
		server.url ?? null,
		server.args ?? [],
	])
}

type RefCheck = { ok: true } | { ok: false; status: 400 | 403; message: string }

/**
 * Where a server may name a saved credential, and who may point it there. A value can hold
 * `${KEYCHAIN_...}` only in env or headers, only for a credential that exists, and only if the
 * person saving may also decide who gets that credential (they saved it, or they are an admin):
 * otherwise anyone could aim a server they control at someone else's key. Re-checked when the
 * command or URL changes, since that is where a reference would be sent.
 */
async function checkReferences(
	db: Database,
	input: {
		workspaceId: string
		callerId: string
		server: CustomMcpServer
		stored: CustomMcpServer | null
	},
): Promise<RefCheck> {
	const { workspaceId, callerId, server, stored } = input
	if (misplacedReferences(server).length > 0) {
		return {
			ok: false,
			status: 400,
			message:
				'A saved credential can only be used in an environment variable or header value, written as ${KEYCHAIN_...}',
		}
	}
	const refs = referencedVars(server)
	if (refs.length === 0) return { ok: true }
	const index = await credentialIndex(db, workspaceId)
	for (const name of refs) {
		if (!index.has(name)) {
			return { ok: false, status: 400, message: `No saved credential matches ${name}` }
		}
	}
	const known = new Set(stored ? referencedVars(stored) : [])
	const targetChanged = !stored || transportKey(stored) !== transportKey(server)
	const toCheck = refs.filter((name) => targetChanged || !known.has(name))
	if (toCheck.length === 0) return { ok: true }
	const mayDecide = await isWorkspaceHumanAdminOrOwner(db, callerId, workspaceId)
	for (const name of toCheck) {
		const entry = index.get(name)
		if (entry && entry.createdBy !== callerId && !mayDecide) {
			return {
				ok: false,
				status: 403,
				message: `Only the person who saved "${entry.displayName}" or a workspace admin can use it in a tool server`,
			}
		}
	}
	return { ok: true }
}

// ── POST /api/custom-mcp-servers ─────────────────────────────────────────

const addServerRoute = createRoute({
	method: 'post',
	path: '/',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Add a custom MCP server to the workspace (humans only)',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: writeBodySchema } }, required: true },
	},
	responses: {
		201: {
			description: 'Added. No agent has it until it is granted',
			content: { 'application/json': { schema: serverResponseSchema } },
		},
		...errorResponses,
	},
})

app.openapi(addServerRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	if (c.get('actorType') !== 'human') {
		return c.json(createApiError('FORBIDDEN', 'Only a person can add a tool server'), 403)
	}
	const { name, server } = c.req.valid('json')
	if (await nameTaken(db, workspaceId, name)) {
		return c.json(createApiError('CONFLICT', 'A tool server with that name already exists'), 409)
	}

	const refCheck = await checkReferences(db, { workspaceId, callerId, server, stored: null })
	if (!refCheck.ok) {
		return c.json(
			createApiError(refCheck.status === 403 ? 'FORBIDDEN' : 'BAD_REQUEST', refCheck.message),
			refCheck.status,
		)
	}

	const created = await db.transaction(async (tx) => {
		const id = randomUUID()
		const [row] = await tx
			.insert(integrations)
			.values({
				id,
				// Unique per server: the index on (workspace, actor, provider) would otherwise let a
				// workspace hold only one.
				externalId: id,
				workspaceId,
				provider: CUSTOM_MCP_PROVIDER,
				status: 'active',
				credentials: encrypt(JSON.stringify({ server })),
				config: configFor(server),
				displayName: name,
				// Explicit grant only: a new server reaches no agent until a person picks them.
				defaultAgentAccess: 'none',
				createdBy: callerId,
			})
			.returning({ id: integrations.id })
		if (!row) throw new Error('Insert returned no row')
		await recordEvent(tx, {
			workspaceId,
			actorId: callerId,
			action: 'created',
			entityType: 'integration',
			entityId: row.id,
			data: { provider: CUSTOM_MCP_PROVIDER, name },
		})
		return row
	})

	return c.json({ id: created.id, name, server: maskServer(server) }, 201)
}) as RouteHandler<typeof addServerRoute, Env>)

// ── GET /api/custom-mcp-servers ──────────────────────────────────────────

// Only what a list row needs. Env and header values, and the keychain references inside them,
// are left out entirely rather than masked: open one by id to see those.
const listItemSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	url: z.string().nullable(),
	status: z.string(),
})

const listServersRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['integrations'],
	summary: "List the workspace's custom MCP servers (no secret values)",
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'The active servers, by name. A stdio server has no URL',
			content: { 'application/json': { schema: z.array(listItemSchema) } },
		},
	},
})

app.openapi(listServersRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const rows = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, CUSTOM_MCP_PROVIDER),
				eq(integrations.status, 'active'),
			),
		)
		.orderBy(sql`lower(${integrations.displayName})`)
	// A row whose definition cannot be read is skipped, as the by-id read answers 404 for it.
	const items = rows.flatMap((row) => {
		const server = readCustomServer(row)
		if (!server) return []
		return [
			{ id: row.id, name: row.displayName ?? '', url: server.url ?? null, status: row.status },
		]
	})
	return c.json(items, 200)
}) as RouteHandler<typeof listServersRoute, Env>)

// ── GET /api/custom-mcp-servers/:id ──────────────────────────────────────

const getServerRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['integrations'],
	summary: 'Read a custom MCP server, with secret values masked',
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			description: 'The server',
			content: { 'application/json': { schema: serverResponseSchema } },
		},
		404: errorResponses[404],
	},
})

app.openapi(getServerRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const row = await loadRow(db, workspaceId, id)
	const server = row ? readCustomServer(row) : null
	if (!row || !server) return c.json(createApiError('NOT_FOUND', 'Tool server not found'), 404)
	return c.json(
		{
			id,
			name: row.displayName ?? '',
			server: maskServer(server),
			signed_in: readSignIn(row) !== null,
		},
		200,
	)
}) as RouteHandler<typeof getServerRoute, Env>)

// ── PUT /api/custom-mcp-servers/:id ──────────────────────────────────────

const updateServerRoute = createRoute({
	method: 'put',
	path: '/{id}',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Change a custom MCP server (humans only)',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		body: { content: { 'application/json': { schema: writeBodySchema } }, required: true },
	},
	responses: {
		200: {
			description: 'Saved. Applies to sessions started after this call',
			content: { 'application/json': { schema: serverResponseSchema } },
		},
		...errorResponses,
	},
})

app.openapi(updateServerRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	if (c.get('actorType') !== 'human') {
		return c.json(createApiError('FORBIDDEN', 'Only a person can change a tool server'), 403)
	}
	const { id } = c.req.valid('param')
	const { name, server: incoming } = c.req.valid('json')

	const row = await loadRow(db, workspaceId, id)
	const stored = row ? readCustomServer(row) : null
	if (!row || !stored) return c.json(createApiError('NOT_FOUND', 'Tool server not found'), 404)
	if (
		row.createdBy !== callerId &&
		!(await isWorkspaceHumanAdminOrOwner(db, callerId, workspaceId))
	) {
		return c.json(
			createApiError(
				'FORBIDDEN',
				'Only the person who added this or a workspace admin can change it',
			),
			403,
		)
	}
	if (await nameTaken(db, workspaceId, name, id)) {
		return c.json(createApiError('CONFLICT', 'A tool server with that name already exists'), 409)
	}

	// A value read back masked keeps what is stored, but only while the command or URL is
	// unchanged: otherwise a mask could be used to send the stored secret somewhere new.
	const { tools, unresolved } = restoreMaskedToolValues(
		{ mcpServers: { s: incoming } },
		{ mcpServers: { s: stored } },
	)
	if (unresolved.length > 0) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				'Re-enter the secret values: they cannot be kept when the command or URL changes',
			),
			400,
		)
	}
	const server = customMcpServerSchema.parse((tools.mcpServers as { s: unknown }).s)
	const refCheck = await checkReferences(db, { workspaceId, callerId, server, stored })
	if (!refCheck.ok) {
		return c.json(
			createApiError(refCheck.status === 403 ? 'FORBIDDEN' : 'BAD_REQUEST', refCheck.message),
			refCheck.status,
		)
	}

	let signedIn = false
	await db.transaction(async (tx) => {
		// A renewal of the sign-in writes the same record, so read it again under its lock: the
		// refresh token it holds may have moved since this request began.
		await lockBlob(tx, id)
		const [fresh] = await tx.select().from(integrations).where(eq(integrations.id, id)).limit(1)
		const credentials = blobForServer(server, fresh ?? row)
		signedIn = readSignIn({ credentials }) !== null
		await tx
			.update(integrations)
			.set({
				credentials,
				config: configFor(server),
				displayName: name,
				updatedAt: new Date(),
			})
			.where(eq(integrations.id, id))
		// Pointing a gated server somewhere it cannot be gated leaves no way to enforce Read, so
		// that level becomes No access rather than quietly turning into Read & write.
		if (!isGatewayable(server)) {
			await tx
				.update(agentGrants)
				.set({ access: 'none' })
				.where(and(eq(agentGrants.integrationId, id), eq(agentGrants.access, 'read')))
		}
		await recordEvent(tx, {
			workspaceId,
			actorId: callerId,
			action: 'updated',
			entityType: 'integration',
			entityId: id,
			data: { provider: CUSTOM_MCP_PROVIDER, name, change: 'tool_server' },
		})
	})

	return c.json({ id, name, server: maskServer(server), signed_in: signedIn }, 200)
}) as RouteHandler<typeof updateServerRoute, Env>)

// ── POST /api/custom-mcp-servers/:id/oauth/start ────────────────────────
//
// For a server that signs people in with a browser (Dinero's does): a person starts the sign-in
// here, opens the address it returns, agrees once, and the callback (GET
// /api/integrations/custom-mcp/callback) keeps the token. After that the gateway sends the token
// upstream and renews it, with no browser. The agent never sees it.

const signInBodySchema = z.object({ return_to: z.string().max(300).optional() }).strict()

const startSignInRoute = createRoute({
	method: 'post',
	path: '/{id}/oauth/start',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Start signing in to a custom MCP server in a browser (humans only)',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		body: { content: { 'application/json': { schema: signInBodySchema } }, required: false },
	},
	responses: {
		200: {
			description: 'Open this address in a browser to sign in. It is good for 10 minutes',
			content: {
				'application/json': { schema: z.object({ authorization_url: z.string().url() }) },
			},
		},
		...errorResponses,
		502: {
			description: 'The server could not be reached to start the sign-in',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

/** The person who added a server, or a workspace admin: the same two who may change it. */
async function mayChange(
	db: Database,
	row: { createdBy: string },
	callerId: string,
	workspaceId: string,
): Promise<boolean> {
	return (
		row.createdBy === callerId || (await isWorkspaceHumanAdminOrOwner(db, callerId, workspaceId))
	)
}

app.openapi(startSignInRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	if (c.get('actorType') !== 'human') {
		return c.json(createApiError('FORBIDDEN', 'Only a person can sign in to a tool server'), 403)
	}
	const { id } = c.req.valid('param')
	const body = (await c.req.json().catch(() => ({}))) as { return_to?: unknown }
	const row = await loadRow(db, workspaceId, id)
	const server = row ? readCustomServer(row) : null
	if (!row || !server) return c.json(createApiError('NOT_FOUND', 'Tool server not found'), 404)
	if (!(await mayChange(db, row, callerId, workspaceId))) {
		return c.json(
			createApiError(
				'FORBIDDEN',
				'Only the person who added this or a workspace admin can sign in to it',
			),
			403,
		)
	}
	// The token is held and sent by the gateway, so only a server the gateway can sit in front of.
	if (!isGatewayable(server)) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				'A browser sign-in needs an HTTP server at a public address, so Maskin can hold the token',
			),
			400,
		)
	}

	const nonce = randomBytes(16).toString('hex')
	const state = encodeState({
		workspaceId,
		actorId: callerId,
		ts: Date.now(),
		nonce,
		customMcpServerId: id,
		returnTo: sanitizeReturnPath(body.return_to, workspaceId),
	})
	const origin = resolvePublicOrigin(c.req.url, c.req.header())
	try {
		const authorizationUrl = await startSignIn(db, {
			integrationId: id,
			server,
			redirectUri: `${origin}/api/integrations/${CUSTOM_MCP_PROVIDER}/callback`,
			nonce,
			state,
		})
		// Binds the sign-in to this browser: the callback needs the cookie to match the state.
		setCookie(c, oauthNonceCookieName(CUSTOM_MCP_PROVIDER), nonce, {
			httpOnly: true,
			sameSite: 'Lax',
			secure: origin.startsWith('https://'),
			path: '/api/integrations',
			maxAge: OAUTH_NONCE_COOKIE_MAX_AGE,
		})
		return c.json({ authorization_url: authorizationUrl }, 200)
	} catch (err) {
		if (!(err instanceof SignInError)) throw err
		return c.json(createApiError('BAD_REQUEST', err.message), err.kind === 'transient' ? 502 : 400)
	}
}) as RouteHandler<typeof startSignInRoute, Env>)

// ── DELETE /api/custom-mcp-servers/:id/oauth ─────────────────────────────

const signOutRoute = createRoute({
	method: 'delete',
	path: '/{id}/oauth',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Forget the browser sign-in of a custom MCP server (humans only)',
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			description: 'The stored sign-in is gone. The server itself is unchanged',
			content: { 'application/json': { schema: z.object({ signed_in: z.literal(false) }) } },
		},
		...errorResponses,
	},
})

app.openapi(signOutRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	if (c.get('actorType') !== 'human') {
		return c.json(createApiError('FORBIDDEN', 'Only a person can sign out of a tool server'), 403)
	}
	const { id } = c.req.valid('param')
	const row = await loadRow(db, workspaceId, id)
	if (!row || !readCustomServer(row)) {
		return c.json(createApiError('NOT_FOUND', 'Tool server not found'), 404)
	}
	if (!(await mayChange(db, row, callerId, workspaceId))) {
		return c.json(
			createApiError(
				'FORBIDDEN',
				'Only the person who added this or a workspace admin can sign out of it',
			),
			403,
		)
	}
	if (await signOut(db, id)) {
		await recordEvent(db, {
			workspaceId,
			actorId: callerId,
			action: 'updated',
			entityType: 'integration',
			entityId: id,
			data: { provider: CUSTOM_MCP_PROVIDER, change: 'tool_server_signed_out' },
		})
	}
	return c.json({ signed_in: false as const }, 200)
}) as RouteHandler<typeof signOutRoute, Env>)

// ── /api/custom-mcp-servers/:id/gateway ──────────────────────────────────
//
// The agent's way to a gated custom server (see isGatewayable): it signs in with its own key,
// Maskin holds the server's headers, and a write is refused for an agent without Read & write.
// The upstream URL comes only from the stored row, never from the request.

async function gateway(c: import('hono').Context<{ Variables: Env['Variables'] }>) {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const id = c.req.param('id') ?? ''
	const workspaceId = c.req.header('x-workspace-id')
	if (!workspaceId)
		return c.json(createApiError('BAD_REQUEST', 'Missing X-Workspace-Id header'), 400)
	if (!z.string().uuid().safeParse(id).success) {
		return c.json(createApiError('NOT_FOUND', 'Tool server not found'), 404)
	}
	if (!(await isWorkspaceWriter(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Actor is not a member of this workspace'), 403)
	}
	const row = await loadRow(db, workspaceId, id)
	const server = row ? readCustomServer(row) : null
	if (!row || !server || !isGatewayable(server) || !server.url) {
		return c.json(createApiError('NOT_FOUND', 'Tool server not found'), 404)
	}
	const url = server.url
	const access = (await resolveAgentAccess(db, workspaceId, id, actorId)) ?? 'none'
	// The session the call comes from, so a credential allowed for only this chat counts. Taken
	// only when it is this agent's own session in this workspace.
	let session: { id: string; conversationId: string | null } | null = null
	const sessionHeader = c.req.header('x-maskin-session-id')
	if (sessionHeader && z.string().uuid().safeParse(sessionHeader).success) {
		const [row] = await db
			.select({ id: sessions.id, conversationId: sessions.conversationId })
			.from(sessions)
			.where(
				and(
					eq(sessions.id, sessionHeader),
					eq(sessions.workspaceId, workspaceId),
					eq(sessions.actorId, actorId),
				),
			)
			.limit(1)
		session = row ?? null
	}
	const label = row.displayName ?? 'This tool server'
	return proxyMcp(c as never, {
		workspaceId,
		actorId,
		provider: CUSTOM_MCP_PROVIDER,
		label,
		integrationId: id,
		access,
		cacheKey: `${workspaceId}:${id}`,
		upstreamUrl: url,
		allowedTools: server.allowed_tools,
		upstreamHeaders: async () => {
			// The name may point somewhere private by now; check what it resolves to.
			if (!(await resolvesPublicly(new URL(url).hostname))) {
				throw new GatewayUpstreamError(
					`${row.displayName ?? 'This tool server'} points at an address Maskin will not call.`,
				)
			}
			let headers: Record<string, string>
			try {
				headers = await fillKeychainReferences(
					db,
					{
						workspaceId,
						actorId,
						conversationId: session?.conversationId ?? null,
						sessionId: session?.id ?? null,
						serverLabel: label,
						outboundTarget: new URL(url).hostname,
					},
					server.headers ?? {},
				)
			} catch (err) {
				if (err instanceof KeychainReferenceError) throw new GatewayUpstreamError(err.message)
				throw err
			}
			// A header still holding a ${PLACEHOLDER} only the container could fill is dropped.
			const out = Object.fromEntries(
				Object.entries(headers).filter(([, v]) => !/\$\{[^}]*\}/.test(v)),
			)
			// A server a person signed in to in a browser: the stored token, renewed when it is about
			// to run out, goes upstream in place of any Authorization header saved with the server.
			let token: string | null
			try {
				token = await getAccessToken(db, row)
			} catch (err) {
				if (!(err instanceof SignInError)) throw err
				throw new GatewayUpstreamError(
					err.kind === 'rejected'
						? `${label} needs a person to sign in to it again.`
						: `${label} could not renew its sign-in just now. Try again.`,
				)
			}
			if (token) {
				for (const name of Object.keys(out)) {
					if (name.toLowerCase() === 'authorization') delete out[name]
				}
				out.Authorization = `Bearer ${token}`
			}
			return out
		},
	})
}

app.on(['GET', 'POST', 'DELETE'], '/:id/gateway', gateway as never)

export default app
