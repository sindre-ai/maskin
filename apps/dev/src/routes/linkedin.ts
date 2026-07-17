import { randomBytes } from 'node:crypto'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, linkedinAccounts, workspaceMembers } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import { decrypt, encrypt } from '../lib/crypto'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import {
	UnipileApiError,
	createHostedAuthLink,
	extractSendingAs,
	findAccountByName,
	getAccountById,
	readUnipileConfig,
} from '../lib/unipile/client'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
	}
}

const app = new OpenAPIHono<Env>()

const STATE_TTL_MS = 15 * 60 * 1000

const linkedinAccountSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	state: z.string(),
	unipileAccountId: z.string().nullable(),
	sendingAsName: z.string().nullable(),
	sendingAsProviderId: z.string().nullable(),
	connectedAt: z.string().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
})

// ── GET /api/linkedin/account ──────────────────────────────────────────────

const getAccountRoute = createRoute({
	method: 'get',
	path: '/account',
	tags: ['linkedin'],
	summary: "Fetch the workspace's LinkedIn account (or null if unconnected)",
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'LinkedIn account or null',
			content: { 'application/json': { schema: linkedinAccountSchema.nullable() } },
		},
	},
})

app.openapi(getAccountRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const [row] = await db
		.select()
		.from(linkedinAccounts)
		.where(eq(linkedinAccounts.workspaceId, workspaceId))
		.limit(1)
	if (!row) return c.json(null)
	return c.json(serializeAccount(row))
}) as RouteHandler<typeof getAccountRoute, Env>)

// ── POST /api/linkedin/connect ─────────────────────────────────────────────

const connectBodySchema = z.object({
	agent_id: z.string().uuid(),
})

const connectRoute = createRoute({
	method: 'post',
	path: '/connect',
	tags: ['linkedin'],
	summary: 'Start the Unipile hosted-auth connect flow',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: connectBodySchema } } },
	},
	responses: {
		200: {
			description: 'Hosted-auth URL to redirect the user to',
			content: { 'application/json': { schema: z.object({ url: z.string() }) } },
		},
		501: {
			description: 'Unipile is not configured on this deployment',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(connectRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { agent_id: agentId } = c.req.valid('json')

	const unipile = readUnipileConfig()
	if (!unipile) {
		return c.json(
			createApiError(
				'INTERNAL_ERROR',
				'Unipile is not configured. Set UNIPILE_API_KEY and UNIPILE_DSN.',
			),
			501,
		)
	}

	// Mark the workspace's account row as `handoff` so a page reload during the
	// dialog reflects the in-flight attempt. Upsert on the workspace-unique
	// index — a second click overwrites the previous handoff state.
	const nonce = randomBytes(16).toString('hex')
	await db
		.insert(linkedinAccounts)
		.values({
			workspaceId,
			state: 'handoff',
			createdBy: actorId,
		})
		.onConflictDoUpdate({
			target: linkedinAccounts.workspaceId,
			set: { state: 'handoff', updatedAt: new Date() },
		})

	const state = encrypt(JSON.stringify({ workspaceId, actorId, agentId, nonce, ts: Date.now() }))

	const origin = resolveOrigin(c.req.url, c.req.header())
	const successRedirectUrl = `${origin}/api/linkedin/callback?state=${encodeURIComponent(state)}`
	const failureRedirectUrl = `${origin}/api/linkedin/callback?state=${encodeURIComponent(state)}&error=failed`

	try {
		const link = await createHostedAuthLink(unipile, {
			name: nonce,
			successRedirectUrl,
			failureRedirectUrl,
		})
		return c.json({ url: link.url })
	} catch (err) {
		logger.error('Unipile hosted-auth link creation failed', {
			workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(
			createApiError('INTERNAL_ERROR', 'Failed to create Unipile hosted-auth link'),
			500,
		)
	}
}) as RouteHandler<typeof connectRoute, Env>)

// ── GET /api/linkedin/callback ─────────────────────────────────────────────
//
// Unipile hosted-auth redirects the user here after they finish the LinkedIn
// login. No auth middleware runs on this path (the browser can't carry our
// bearer token on a third-party redirect) — the encrypted `state` is our
// authenticator instead: it names the workspace + actor + agent + a one-time
// nonce that we verify against the pending `handoff` row.

const callbackQuerySchema = z.object({
	state: z.string(),
	account_id: z.string().optional(),
	name: z.string().optional(),
	error: z.string().optional(),
	success: z.string().optional(),
	status: z.string().optional(),
})

const callbackRoute = createRoute({
	method: 'get',
	path: '/callback',
	tags: ['linkedin'],
	summary: "Unipile hosted-auth redirect target — lands the account in 'syncing'",
	request: { query: callbackQuerySchema },
	responses: {
		302: { description: 'Redirect back to the agent detail page' },
		400: {
			description: 'Invalid state or expired nonce',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(callbackRoute, (async (c) => {
	const db = c.get('db')
	const query = c.req.valid('query')

	let stateData: {
		workspaceId: string
		actorId: string
		agentId: string
		nonce: string
		ts: number
	}
	try {
		stateData = JSON.parse(decrypt(query.state))
	} catch {
		return c.json(createApiError('BAD_REQUEST', 'Invalid state parameter'), 400)
	}

	if (Date.now() - stateData.ts > STATE_TTL_MS) {
		return c.json(
			createApiError('BAD_REQUEST', 'State expired — please restart the connect flow'),
			400,
		)
	}

	// Confirm the actor is still a workspace member. `authMiddleware` normally
	// enforces this on `X-Workspace-Id` routes; this callback has neither the
	// header nor the bearer token, so we do the check inline.
	const [member] = await db
		.select()
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.workspaceId, stateData.workspaceId),
				eq(workspaceMembers.actorId, stateData.actorId),
			),
		)
		.limit(1)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Actor is no longer a member of this workspace'), 400)
	}

	const frontendUrl = resolveFrontendUrl()
	const agentPath = `/${stateData.workspaceId}/agents/${stateData.agentId}`

	// Failure branch — Unipile bounced the user back with an error param.
	if (query.error) {
		logger.warn('Unipile hosted-auth callback returned error', {
			workspaceId: stateData.workspaceId,
			error: query.error,
		})
		return c.redirect(`${frontendUrl}${agentPath}?linkedin=failed`)
	}

	const unipile = readUnipileConfig()
	if (!unipile) {
		return c.json(
			createApiError('INTERNAL_ERROR', 'Unipile is not configured on this deployment'),
			400,
		)
	}

	// Prefer the `account_id` query param when Unipile appends it; otherwise
	// look the account up by the nonce we passed as `name` on link creation.
	let account = null as Awaited<ReturnType<typeof getAccountById>> | null
	try {
		if (query.account_id) {
			account = await getAccountById(unipile, query.account_id)
		}
		if (!account) {
			account = await findAccountByName(unipile, stateData.nonce)
		}
	} catch (err) {
		logger.error('Unipile account lookup failed on callback', {
			workspaceId: stateData.workspaceId,
			error: err instanceof Error ? err.message : String(err),
			...(err instanceof UnipileApiError ? { status: err.status, path: err.path } : {}),
		})
	}

	if (!account) {
		logger.warn('Unipile callback landed but account was not resolvable', {
			workspaceId: stateData.workspaceId,
			nonce: stateData.nonce,
			accountIdFromQuery: query.account_id,
		})
		return c.redirect(`${frontendUrl}${agentPath}?linkedin=not_found`)
	}

	const sendingAs = extractSendingAs(account)

	// ── Success branch ─────────────────────────────────────────────────────
	// Persist the row in `syncing`, write the audit event, then redirect. T2
	// extends this branch by adding a `posthog.capture('linkedin_account_connected')`
	// call between the events insert and the redirect — the block is intentionally
	// contiguous so it takes a single-line append with no surrounding edits.

	const now = new Date()
	const upserted = await db
		.insert(linkedinAccounts)
		.values({
			workspaceId: stateData.workspaceId,
			state: 'syncing',
			unipileAccountId: account.id,
			sendingAsName: sendingAs.name,
			sendingAsProviderId: sendingAs.providerId,
			connectedAt: now,
			createdBy: stateData.actorId,
		})
		.onConflictDoUpdate({
			target: linkedinAccounts.workspaceId,
			set: {
				state: 'syncing',
				unipileAccountId: account.id,
				sendingAsName: sendingAs.name,
				sendingAsProviderId: sendingAs.providerId,
				connectedAt: now,
				updatedAt: now,
			},
		})
		.returning({ id: linkedinAccounts.id })

	const accountRowId = upserted[0]?.id
	if (accountRowId) {
		await db.insert(events).values({
			workspaceId: stateData.workspaceId,
			actorId: stateData.actorId,
			action: 'created',
			entityType: 'linkedin_account',
			entityId: accountRowId,
			data: {
				unipile_account_id: account.id,
				sending_as_name: sendingAs.name,
				sending_as_provider_id: sendingAs.providerId,
				state: 'syncing',
			},
		})
	}

	return c.redirect(`${frontendUrl}${agentPath}?linkedin=connected`)
}) as RouteHandler<typeof callbackRoute, Env>)

export default app

// ── Helpers ────────────────────────────────────────────────────────────────

interface LinkedinAccountRow {
	id: string
	workspaceId: string
	state: string
	unipileAccountId: string | null
	sendingAsName: string | null
	sendingAsProviderId: string | null
	connectedAt: Date | null
	createdAt: Date | null
	updatedAt: Date | null
}

function serializeAccount(row: LinkedinAccountRow) {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		state: row.state,
		unipileAccountId: row.unipileAccountId,
		sendingAsName: row.sendingAsName,
		sendingAsProviderId: row.sendingAsProviderId,
		connectedAt: row.connectedAt ? row.connectedAt.toISOString() : null,
		createdAt: row.createdAt ? row.createdAt.toISOString() : null,
		updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
	}
}

function resolveOrigin(requestUrl: string, headers: Record<string, string | undefined>): string {
	const corsOrigin = process.env.CORS_ORIGIN
	if (corsOrigin) {
		const origin = (corsOrigin.split(',')[0] ?? corsOrigin).trim().replace(/\/$/, '')
		if (origin.startsWith('http')) {
			// CORS_ORIGIN points at the frontend; the API lives on the same host in
			// production. Prefer API_BASE_URL when it's explicitly set.
			return process.env.API_BASE_URL?.replace(/\/$/, '') ?? origin
		}
	}
	const forwardedHost = headers['x-forwarded-host']
	const forwardedProto = headers['x-forwarded-proto']
	if (forwardedHost) {
		const proto = forwardedProto ?? 'https'
		return `${proto}://${forwardedHost}`
	}
	return new URL(requestUrl).origin
}

function resolveFrontendUrl(): string {
	return (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '')
}
