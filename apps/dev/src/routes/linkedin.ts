import { randomBytes } from 'node:crypto'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, linkedinAccounts, workspaceMembers } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import {
	trackLinkedinAccountConnected,
	trackLinkedinMessageSent,
} from '../lib/analytics/linkedin-events'
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
	sendChatMessage,
} from '../lib/unipile/client'

const SENDABLE_ACCOUNT_STATES = new Set(['syncing', 'warm_up', 'healthy'])

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

// `return_path` lets a caller (e.g. Settings › Integrations, T5) send the
// user back to a surface that isn't the agent detail page. Validated to a
// safe relative path so a malicious body can't turn our callback redirect
// into an open redirect. When absent, the callback falls back to the T1
// default of `/{workspaceId}/agents/{agentId}` — so either `agent_id` or
// `return_path` (or both) must be supplied.
const RETURN_PATH_MAX_LENGTH = 200
function isSafeReturnPath(p: string): boolean {
	if (!p || p.length > RETURN_PATH_MAX_LENGTH) return false
	if (!p.startsWith('/')) return false
	if (p.startsWith('//')) return false
	if (p.includes('://')) return false
	if (p.includes('\\')) return false
	return true
}

const connectBodySchema = z
	.object({
		agent_id: z.string().uuid().optional(),
		return_path: z
			.string()
			.max(RETURN_PATH_MAX_LENGTH)
			.refine(
				isSafeReturnPath,
				'return_path must be a safe relative path (starts with /, no scheme)',
			)
			.optional(),
	})
	.refine((v) => v.agent_id || v.return_path, {
		message: 'Provide agent_id or return_path',
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
	const { agent_id: agentId, return_path: returnPath } = c.req.valid('json')

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

	const state = encrypt(
		JSON.stringify({ workspaceId, actorId, agentId, returnPath, nonce, ts: Date.now() }),
	)

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
		agentId?: string
		returnPath?: string
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
	// Prefer the caller-supplied returnPath (Settings › Integrations passes
	// `/{workspaceId}/settings/integrations`); fall back to the T1 default of
	// the agent detail page when only `agent_id` was supplied. Defensive
	// re-validation — the state is encrypted with our key, but a bad path
	// slipping through would turn the callback into an open redirect.
	const returnPath =
		stateData.returnPath && isSafeReturnPath(stateData.returnPath)
			? stateData.returnPath
			: stateData.agentId
				? `/${stateData.workspaceId}/agents/${stateData.agentId}`
				: `/${stateData.workspaceId}`

	// Failure branch — Unipile bounced the user back with an error param.
	if (query.error) {
		logger.warn('Unipile hosted-auth callback returned error', {
			workspaceId: stateData.workspaceId,
			error: query.error,
		})
		return c.redirect(`${frontendUrl}${returnPath}?linkedin=failed`)
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
		return c.redirect(`${frontendUrl}${returnPath}?linkedin=not_found`)
	}

	const sendingAs = extractSendingAs(account)

	// ── Success branch ─────────────────────────────────────────────────────
	// Persist the row in `syncing`, write the audit event, emit the ship-metric
	// PostHog event, then redirect.

	// Peek at the current row so we can pick the right event action after the
	// upsert. Only a first-time connect (no row, or the pre-callback `handoff`
	// placeholder) should log `created`; a `restricted`/`reconnect` recovery
	// logs `reconnected`; a redirect-replay against an already-syncing row logs
	// `updated`.
	const [priorRow] = await db
		.select({ state: linkedinAccounts.state })
		.from(linkedinAccounts)
		.where(eq(linkedinAccounts.workspaceId, stateData.workspaceId))
		.limit(1)

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

	const priorState = priorRow?.state
	const isFirstSuccessfulConnect = !priorState || priorState === 'handoff'

	const accountRowId = upserted[0]?.id
	if (accountRowId) {
		const action: 'created' | 'reconnected' | 'updated' = isFirstSuccessfulConnect
			? 'created'
			: priorState === 'restricted' || priorState === 'reconnect'
				? 'reconnected'
				: 'updated'
		await db.insert(events).values({
			workspaceId: stateData.workspaceId,
			actorId: stateData.actorId,
			action,
			entityType: 'linkedin_account',
			entityId: accountRowId,
			data: {
				unipile_account_id: account.id,
				sending_as_name: sendingAs.name,
				sending_as_provider_id: sendingAs.providerId,
				state: 'syncing',
				...(priorState ? { prior_state: priorState } : {}),
			},
		})
	}

	// Ship-metric emit. Gate on first-time connect (row absent or `handoff`
	// placeholder) so a redirect-replay within the state TTL and a
	// `reconnected` recovery both stay silent — the bet's compound query
	// counts distinct workspaces via distinct_id already, but the DoD says
	// "fires exactly once on successful hosted-auth handoff".
	if (isFirstSuccessfulConnect) {
		await trackLinkedinAccountConnected({
			workspaceId: stateData.workspaceId,
			actorId: stateData.actorId,
			unipileAccountId: account.id,
		})
	}

	return c.redirect(`${frontendUrl}${returnPath}?linkedin=connected`)
}) as RouteHandler<typeof callbackRoute, Env>)

// ── POST /api/linkedin/messages ────────────────────────────────────────────
//
// Send-half of the bet's compound ship metric. Sends a LinkedIn message via
// the workspace's customer-connected Unipile account and emits the
// `linkedin_message_sent` PostHog event on success.
//
// Guardrails:
//   - The route reads the workspace's `linkedin_accounts` row. If none exists,
//     404 — the workspace hasn't connected a LinkedIn account and no send is
//     possible.
//   - The account state must be `syncing`, `warm_up`, or `healthy`. Any other
//     state (`handoff`, `restricted`, `reconnect`) blocks the send with 409
//     per the bet AC ("Restricted state stops all agent sending", "Reconnect
//     state pauses the agent").
//   - The Idempotency-Key middleware in front of `/api/*` prevents client
//     retries with the same key from re-hitting Unipile (and re-emitting).
//   - The PostHog emit is inside the success branch after Unipile returns
//     2xx — a failed send never emits.

const sendMessageBodySchema = z
	.object({
		text: z.string().min(1).max(8000),
		chat_id: z.string().min(1).optional(),
		attendees_provider_ids: z.array(z.string().min(1)).min(1).optional(),
	})
	.refine((v) => v.chat_id || (v.attendees_provider_ids && v.attendees_provider_ids.length > 0), {
		message: 'Either chat_id or attendees_provider_ids must be provided',
	})

const sendMessageResponseSchema = z.object({
	chat_id: z.string(),
	message_id: z.string(),
})

const sendMessageRoute = createRoute({
	method: 'post',
	path: '/messages',
	tags: ['linkedin'],
	summary: "Send a LinkedIn message via the workspace's connected account",
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: sendMessageBodySchema } } },
	},
	responses: {
		200: {
			description: 'Message sent',
			content: { 'application/json': { schema: sendMessageResponseSchema } },
		},
		404: {
			description: 'No LinkedIn account connected for this workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'Account is not in a sendable state',
			content: { 'application/json': { schema: errorSchema } },
		},
		501: {
			description: 'Unipile is not configured on this deployment',
			content: { 'application/json': { schema: errorSchema } },
		},
		502: {
			description: 'Unipile rejected the send',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(sendMessageRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

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

	const [account] = await db
		.select({
			id: linkedinAccounts.id,
			state: linkedinAccounts.state,
			unipileAccountId: linkedinAccounts.unipileAccountId,
		})
		.from(linkedinAccounts)
		.where(eq(linkedinAccounts.workspaceId, workspaceId))
		.limit(1)

	if (!account || !account.unipileAccountId) {
		return c.json(
			createApiError('NOT_FOUND', 'No LinkedIn account connected for this workspace'),
			404,
		)
	}

	if (!SENDABLE_ACCOUNT_STATES.has(account.state)) {
		return c.json(
			createApiError('CONFLICT', `LinkedIn account is in state '${account.state}' and cannot send`),
			409,
		)
	}

	let result: Awaited<ReturnType<typeof sendChatMessage>>
	try {
		result = await sendChatMessage(unipile, {
			accountId: account.unipileAccountId,
			chatId: body.chat_id,
			attendeesProviderIds: body.attendees_provider_ids,
			text: body.text,
		})
	} catch (err) {
		logger.error('Unipile send failed', {
			workspaceId,
			error: err instanceof Error ? err.message : String(err),
			...(err instanceof UnipileApiError ? { status: err.status, path: err.path } : {}),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to send LinkedIn message'), 502)
	}

	await trackLinkedinMessageSent({
		workspaceId,
		actorId,
		unipileAccountId: account.unipileAccountId,
		chatId: result.chatId,
		messageId: result.messageId,
	})

	return c.json({ chat_id: result.chatId, message_id: result.messageId })
}) as RouteHandler<typeof sendMessageRoute, Env>)

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
