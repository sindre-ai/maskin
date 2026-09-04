import { randomBytes, timingSafeEqual } from 'node:crypto'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { INTEGRATION_STATUS_ACTIVE, type Integration, integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { trackIntegrationConnected } from '../lib/analytics/integration-events'
import { decrypt, encrypt } from '../lib/crypto'
import { createApiError, validationFailureHook } from '../lib/errors'
import { createAuthLink } from '../lib/integrations/providers/linkedin-unipile/client'
import {
	LinkedInIntegrationError,
	isLinkedInIntegrationError,
} from '../lib/integrations/providers/linkedin-unipile/errors'
import {
	listLinkedInConversations,
	replyToLinkedInThread,
	sendLinkedInMessage,
} from '../lib/integrations/providers/linkedin-unipile/operations'
import {
	startLinkedInAddonCheckout,
	syncLinkedInAddonQuantity,
} from '../lib/linkedin-addon-billing'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
/**
 * LinkedIn (Unipile-backed) integration routes — the whole provider surface,
 * rebuilt against Unipile Hosted Auth v2.
 *
 * Connect flow (v2 hosted-auth):
 *   - POST /connect            — creates or looks up a pending integrations
 *                                row keyed by (workspace, actor, provider),
 *                                calls Unipile POST /v2/auth/link, and
 *                                returns { install_url } to the UI. Auth: API key.
 *   - GET  /callback           — redirect callback with query params
 *                                (state, account_id, provider) on success
 *                                or (error_type, error_detail, state) on
 *                                error. v1's HMAC-signed POST body is gone —
 *                                auth is the unguessable `state` round-trip
 *                                binding. Path is exempt from the API-key
 *                                middleware (see app-factory.ts's callback
 *                                allowlist regex).
 *
 * Message verbs (v2 messaging), which the MCP tools in packages/mcp/src/server.ts
 * proxy to:
 *   - POST /send-message       — POST /v2/{account_id}/chats/send
 *   - POST /reply              — POST /v2/{account_id}/chats/{chat_id}/messages/send
 *   - GET  /list-conversations — GET  /v2/{account_id}/chats
 *
 * The verbs share one shape: fetch the actor-scoped credential the connect
 * flow above landed (via `getIntegrationCredential`, on the actor_id column
 * Task 1 added), call Unipile through the thin `UnipileClient`, and translate
 * every failure into one of the six `LinkedInIntegrationError` classes before
 * the response leaves this file. This is therefore the single spot that talks
 * to Unipile, decrypts credentials, or applies the idempotency ledger — every
 * ergonomics decision (retry policy, body redaction on log, idempotency key
 * scoping) sits at this layer so the MCP surface stays a dumb passthrough.
 *
 * Design notes rooted in the spec (see the parent bet's technical spec §2):
 *   - LinkedIn tokens NEVER cross Maskin infrastructure. The stored credential
 *     is Unipile's own account_id, which we combine with the workspace-scoped
 *     MASKIN_UNIPILE_API_KEY on every downstream call.
 *   - The DB commit runs first; the PostHog capture runs after with await
 *     but is fire-and-forget internally (capturePosthogEvent catches every
 *     failure). An unlogged event is strictly better than a rolled-back
 *     credential write — see spec §Telemetry ordering rule.
 *   - We do NOT reuse the generic OAuth2Handler — Unipile's hosted wizard is
 *     not an OAuth2 authorization-code flow. The provider is registered in
 *     the integration registry with auth.type='oauth2_custom' as a sentinel
 *     so it appears in Settings > Integrations, and this dedicated router is
 *     mounted at /api/integrations/linkedin-unipile BEFORE the generic
 *     /api/integrations mount so Hono's trie routes the more specific prefix
 *     to us instead of the generic /{provider}/connect handler.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const PROVIDER = 'linkedin-unipile'

/**
 * The status a successfully-landed credential row carries.
 *
 * Aliases the shared `INTEGRATION_STATUS_ACTIVE` so this provider cannot drift
 * from the vocabulary every reader filters on — `lib/integrations/lookup.ts`'s
 * `getIntegrationCredential`, `lib/linkedin-addon.ts`'s SKU count,
 * `oauth/token-manager.ts`, and every `routes/integrations.ts` list query.
 *
 * The column is typed `IntegrationStatus`, so an invented literal is now a
 * compile error. It used to be plain `text`: writing any other value was
 * accepted by Postgres and then silently matched nothing on read, leaving the
 * connect flow apparently successful and the integration invisible forever.
 */
const CONNECTED_STATUS = INTEGRATION_STATUS_ACTIVE

function callbackUrl(): string {
	const base = (process.env.MASKIN_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '')
	return `${base}/api/integrations/linkedin-unipile/callback`
}

// ── Hosted-auth `state` binding ───────────────────────────────────────────
// The callback is unauthenticated (it is a browser redirect, so no API key
// can ride along) — `state` is the ONLY thing binding the response to the
// request we made. It therefore has to be secret, single-use and expiring.
//
// `integrations.id` alone satisfies none of those: `GET /api/integrations`
// returns whole rows to every workspace member, so a co-member can read the
// id and re-point a colleague's LinkedIn identity at their own Unipile
// account; and a state that never expires or gets consumed means the
// callback URL sitting in browser history rebinds a live integration every
// time it is replayed.
//
// So `state` is `<integrationId>.<nonce>`: the id locates the row without a
// scan, and the nonce authenticates the caller. The nonce lives in the
// row's own encrypted `credentials` blob — it never leaves the server
// (`routes/integrations.ts` strips `credentials` from every list response)
// and needs no migration. Landing a credential overwrites the blob, which
// is what consumes it.
const AUTH_NONCE_TTL_MS = 10 * 60_000

type StoredAuthBlob = {
	account_id?: string
	auth_nonce?: string
	nonce_expires_at?: string
}

/**
 * Decrypt a row's credentials blob. Returns `{}` for the empty string a
 * freshly-inserted pending row carries, and for an undecryptable blob (an
 * encryption-key rotation) — in both cases the caller has no valid nonce to
 * compare against and must reject, which is the safe direction.
 */
function readStoredAuthBlob(raw: string): StoredAuthBlob {
	if (!raw) return {}
	try {
		const parsed: unknown = JSON.parse(decrypt(raw))
		return parsed && typeof parsed === 'object' ? (parsed as StoredAuthBlob) : {}
	} catch {
		return {}
	}
}

/** Split on the LAST dot — UUIDs contain no dots, but be explicit about it. */
function parseCallbackState(state: string): { integrationId: string; nonce: string } | null {
	const i = state.lastIndexOf('.')
	if (i <= 0 || i === state.length - 1) return null
	return { integrationId: state.slice(0, i), nonce: state.slice(i + 1) }
}

function nonceMatches(stored: string | undefined, presented: string): boolean {
	if (!stored) return false
	const a = Buffer.from(stored, 'utf8')
	const b = Buffer.from(presented, 'utf8')
	// timingSafeEqual throws on a length mismatch, so guard first. The length
	// itself is not a secret (every nonce we mint is the same width).
	return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Resolve the `state` a callback arrived with to the pending row that minted
 * it, verifying the nonce and its expiry. Every rejection is deliberately
 * reported to the user as the same opaque `unknown_state` — distinguishing
 * "no such row" from "bad nonce" would hand an attacker an oracle.
 */
async function resolveCallbackState(
	db: Database,
	state: string,
): Promise<{ ok: true; row: Integration } | { ok: false; reason: string }> {
	const parts = parseCallbackState(state)
	if (!parts) return { ok: false, reason: 'malformed_state' }
	const [row] = await db
		.select()
		.from(integrations)
		.where(and(eq(integrations.id, parts.integrationId), eq(integrations.provider, PROVIDER)))
		.limit(1)
	if (!row) return { ok: false, reason: 'no_row' }
	const blob = readStoredAuthBlob(row.credentials)
	if (!nonceMatches(blob.auth_nonce, parts.nonce)) return { ok: false, reason: 'bad_nonce' }
	const expiresAt = blob.nonce_expires_at ? Date.parse(blob.nonce_expires_at) : Number.NaN
	if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
		return { ok: false, reason: 'expired_nonce' }
	}
	return { ok: true, row }
}

// ── POST /connect ──────────────────────────────────────────────────────────

const connectRoute = createRoute({
	method: 'post',
	path: '/connect',
	tags: ['integrations'],
	summary: 'Start LinkedIn Unipile Hosted Auth Wizard connect flow',
	request: {
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			description: 'Unipile-hosted install URL for the customer to complete LinkedIn auth in.',
			content: {
				'application/json': {
					schema: z.object({
						install_url: z.string().url(),
						integration_id: z.string().uuid(),
					}),
				},
			},
		},
		500: {
			description: 'Error',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(connectRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	// Look up or insert a pending row keyed by (workspace, actor, provider).
	// credentials starts as an empty string because the column is NOT NULL
	// but we don't have any credential material until /callback fires.
	const existing = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.actorId, actorId),
				eq(integrations.provider, PROVIDER),
			),
		)
		.limit(1)

	// Mint the nonce that authenticates the callback. It is written to the row
	// BEFORE the wizard link is handed out, so a callback can never arrive for
	// a nonce we have not yet persisted.
	const authNonce = randomBytes(32).toString('hex')
	const nonceExpiresAt = new Date(Date.now() + AUTH_NONCE_TTL_MS).toISOString()

	let integrationId: string
	if (existing[0]) {
		integrationId = existing[0].id
		// 'active' is the shared vocabulary — see CONNECTED_STATUS. Re-running
		// the wizard against an already-active row must NOT demote it to
		// pending, or the credential goes unreadable until the callback lands.
		// For the same reason the existing account_id is carried across when the
		// nonce is written in: reconnecting must not blind the live credential.
		const prior = readStoredAuthBlob(existing[0].credentials)
		await db
			.update(integrations)
			.set({
				credentials: encrypt(
					JSON.stringify({
						...(prior.account_id ? { account_id: prior.account_id } : {}),
						auth_nonce: authNonce,
						nonce_expires_at: nonceExpiresAt,
					}),
				),
				...(existing[0].status === CONNECTED_STATUS ? {} : { status: 'pending' as const }),
				updatedAt: new Date(),
			})
			.where(eq(integrations.id, integrationId))
	} else {
		const [row] = await db
			.insert(integrations)
			.values({
				workspaceId,
				actorId,
				provider: PROVIDER,
				status: 'pending',
				credentials: encrypt(
					JSON.stringify({ auth_nonce: authNonce, nonce_expires_at: nonceExpiresAt }),
				),
				createdBy: actorId,
			})
			.returning({ id: integrations.id })
		if (!row?.id) {
			return c.json(createApiError('INTERNAL_ERROR', 'Failed to allocate integration row'), 500)
		}
		integrationId = row.id
	}

	try {
		const link = await createAuthLink({
			providers: ['linkedin'],
			expires_on: new Date(Date.now() + 10 * 60_000).toISOString(),
			redirect_uri: callbackUrl(),
			state: `${integrationId}.${authNonce}`,
		})
		return c.json({ install_url: link.link, integration_id: integrationId })
	} catch (err) {
		// `cause` carries the real Unipile status/body (or the schema-drift
		// detail); `message` is only the class's stock human-facing text, which
		// reads as "temporarily unavailable" for every failure mode including a
		// 200 we could not parse. Log both.
		const cause = err instanceof LinkedInIntegrationError ? err.cause : undefined
		logger.error('linkedin-unipile connect: hosted-link creation failed', {
			workspaceId,
			actorId,
			error: err instanceof Error ? err.message : String(err),
			cause: cause instanceof Error ? cause.message : cause ? String(cause) : undefined,
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to start LinkedIn connect flow'), 500)
	}
}) as RouteHandler<typeof connectRoute, Env>)

// ── GET /callback ──────────────────────────────────────────────────────────
// v2 replaces the v1 HMAC-signed POST body with a browser redirect carrying
// query params. Auth for the callback is the unguessable `state` round-trip
// binding, not a signature. On success we 302 back to Settings > Integrations
// with a status/detail query pair the frontend renders as the connect result.

const CallbackSuccessQuerySchema = z.object({
	account_id: z.string().min(1),
	provider: z.string().min(1),
	state: z.string().min(1),
})

const CallbackErrorQuerySchema = z.object({
	error_type: z.string().min(1),
	error_title: z.string().optional(),
	error_detail: z.string().optional(),
	state: z.string().optional(),
})

const callbackRoute = createRoute({
	method: 'get',
	path: '/callback',
	tags: ['integrations'],
	summary: 'Unipile Hosted Auth v2 redirect callback',
	responses: {
		302: {
			description: 'Redirect to Settings > Integrations with connect status.',
		},
	},
})

app.openapi(callbackRoute, (async (c) => {
	const db = c.get('db')
	const query = c.req.query()

	// Error path — Unipile aborted or LinkedIn refused.
	if (query.error_type) {
		return handleCallbackError(c, db, query)
	}

	const parsed = CallbackSuccessQuerySchema.safeParse(query)
	if (!parsed.success) {
		logger.warn('linkedin-unipile callback: malformed success query', {
			present: Object.keys(query),
		})
		return redirectToSettings(c, 'error', 'invalid_callback')
	}
	const { account_id, provider, state } = parsed.data
	if (provider !== 'linkedin') {
		logger.warn('linkedin-unipile callback: unexpected provider', { provider, state })
		return redirectToSettings(c, 'error', 'wrong_provider')
	}

	const resolved = await resolveCallbackState(db, state)
	if (!resolved.ok) {
		logger.warn('linkedin-unipile callback: state rejected', { reason: resolved.reason })
		return redirectToSettings(c, 'error', 'unknown_state')
	}
	const pending = resolved.row

	// Landing the credential drops auth_nonce/nonce_expires_at from the blob,
	// which is what makes the state single-use: a replay of this exact URL now
	// resolves to 'bad_nonce' instead of rebinding a live integration.
	const encrypted = encrypt(JSON.stringify({ account_id }))

	// Single-transaction credential landing (spec §Telemetry ordering rule):
	// the PostHog capture runs AFTER commit so a rolled-back write can never
	// leak a fake integration_connected signal.
	await db.transaction(async (tx) => {
		await tx
			.update(integrations)
			.set({
				credentials: encrypted,
				externalId: account_id,
				status: CONNECTED_STATUS,
				updatedAt: new Date(),
			})
			.where(eq(integrations.id, pending.id))
	})

	if (pending.actorId) {
		await trackIntegrationConnected({
			provider: PROVIDER,
			workspaceId: pending.workspaceId,
			actorId: pending.actorId,
			integrationId: pending.id,
		})
	} else {
		logger.warn('linkedin-unipile callback: pending row missing actor_id — event skipped', {
			integrationId: pending.id,
		})
	}

	// Bill the identity. Ordering matters: the credential is already committed
	// above, so a Stripe failure here leaves a working connection that is not
	// yet billed (self-healing on the next connect/disconnect sync) rather than
	// a paid line with no connection. `syncLinkedInAddonQuantity` swallows its
	// own Stripe errors for the same reason.
	const sync = await syncLinkedInAddonQuantity(db, pending.workspaceId)
	if (sync.status === 'checkout_required') {
		// Trial workspace: no plan subscription to attach the $49 item to, so
		// the add-on gets its own single-line subscription via its own Checkout.
		// Cancelling that Checkout returns to Settings with the connection
		// intact but unbilled — the integrations page surfaces that state, and
		// the next sync retries.
		const settingsUrl = settingsIntegrationsUrl(pending.workspaceId)
		const checkoutUrl = await startLinkedInAddonCheckout(db, pending.workspaceId, {
			successUrl: `${settingsUrl}?linkedin_status=connected&linkedin_detail=${encodeURIComponent(account_id)}`,
			cancelUrl: `${settingsUrl}?linkedin_status=unbilled&linkedin_detail=checkout_canceled`,
		})
		if (checkoutUrl) return c.redirect(checkoutUrl, 302)
		logger.warn('LinkedIn connected on a workspace with no way to bill the add-on', {
			workspaceId: pending.workspaceId,
			integrationId: pending.id,
		})
	}

	return redirectToSettings(c, 'connected', account_id, pending.workspaceId)
}) as RouteHandler<typeof callbackRoute, Env>)

/**
 * Where the browser lands after the wizard. This is the SPA, not the API —
 * MASKIN_PUBLIC_URL is the backend origin and would 404 — and the settings
 * route is workspace-scoped (`apps/web/src/routes/_authed/$workspaceId/
 * settings/integrations.tsx`), matching what every other OAuth callback in
 * routes/integrations.ts already builds.
 *
 * When the state never resolved to a row there is no workspace to address,
 * so we hand the user to the app root and let it route them.
 */
function settingsIntegrationsUrl(workspaceId?: string): string {
	const base = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')
	return workspaceId ? `${base}/${workspaceId}/settings/integrations` : `${base}/`
}

function redirectToSettings(
	c: Context,
	status: 'connected' | 'error',
	detail: string,
	workspaceId?: string,
): Response {
	const url = new URL(settingsIntegrationsUrl(workspaceId))
	url.searchParams.set('linkedin_status', status)
	url.searchParams.set('linkedin_detail', detail)
	return c.redirect(url.toString(), 302)
}

async function handleCallbackError(
	c: Context,
	db: Database,
	q: Record<string, string>,
): Promise<Response> {
	const parsed = CallbackErrorQuerySchema.safeParse(q)
	if (!parsed.success) {
		return redirectToSettings(c, 'error', 'malformed_error')
	}
	const { error_type, error_detail, state } = parsed.data

	// `api/already_exists` is a "success with a twist" — the customer already
	// connected this LinkedIn account previously. `error_detail` carries the
	// existing Unipile account_id; adopt it into the pending row so the customer
	// isn't stuck in a reconnect loop.
	if (error_type === 'api/already_exists' && state && error_detail) {
		const resolved = await resolveCallbackState(db, state)
		if (resolved.ok) {
			const pending = resolved.row
			const encrypted = encrypt(JSON.stringify({ account_id: error_detail }))
			await db.transaction(async (tx) => {
				await tx
					.update(integrations)
					.set({
						credentials: encrypted,
						externalId: error_detail,
						status: CONNECTED_STATUS,
						updatedAt: new Date(),
					})
					.where(eq(integrations.id, pending.id))
			})
			if (pending.actorId) {
				await trackIntegrationConnected({
					provider: PROVIDER,
					workspaceId: pending.workspaceId,
					actorId: pending.actorId,
					integrationId: pending.id,
				})
			}
			return redirectToSettings(c, 'connected', error_detail, pending.workspaceId)
		}
		logger.warn('linkedin-unipile callback already_exists: state rejected', {
			reason: resolved.reason,
		})
		return redirectToSettings(c, 'error', 'unknown_state')
	}

	if (error_type === 'api/restricted_account') {
		return redirectToSettings(c, 'error', 'account_restricted')
	}
	// Log the integration id only — `state` carries the auth nonce, and a
	// secret that reaches the log line is no longer a secret.
	logger.warn('linkedin-unipile callback: unknown error_type', {
		error_type,
		integrationId: state ? parseCallbackState(state)?.integrationId : undefined,
	})
	return redirectToSettings(c, 'error', error_type)
}
// ── Message verbs (send-message / reply / list-conversations) ─────────────
//
// The decision logic — credential lookup, error classification, retry policy,
// idempotency dedup, response normalisation — lives in
// `lib/integrations/providers/linkedin-unipile/operations.ts`, because the
// in-process MCP server (`routes/integrations-linkedin-unipile-mcp.ts`) is a
// second caller of the same three operations. What remains here is the HTTP
// shell: read the header, call the operation, map a thrown
// `LinkedInIntegrationError` onto its status code.

function readWorkspaceIdHeader(req: { header(name: string): string | undefined }): string | null {
	const raw = req.header('x-workspace-id') ?? req.header('X-Workspace-Id')
	return raw && raw.length > 0 ? raw : null
}

function errorToResponse(err: LinkedInIntegrationError) {
	return {
		error: {
			code: err.code,
			message: err.message,
		},
	}
}

function handleTerminalError(err: unknown, operation: string, actorId: string): Response {
	if (isLinkedInIntegrationError(err)) {
		logger.warn('LinkedIn integration error', {
			operation,
			actorId,
			code: err.code,
			retryable: err.retryable,
		})
		return new Response(JSON.stringify(errorToResponse(err)), {
			status: err.httpStatus,
			headers: { 'content-type': 'application/json' },
		})
	}
	logger.error('LinkedIn route unexpected error', {
		operation,
		actorId,
		error: err instanceof Error ? err.message : String(err),
	})
	const generic = new LinkedInIntegrationError('UNIPILE_UNAVAILABLE', 'Unexpected upstream error', {
		cause: err,
	})
	return new Response(JSON.stringify(errorToResponse(generic)), {
		status: generic.httpStatus,
		headers: { 'content-type': 'application/json' },
	})
}

// ── POST /api/integrations/linkedin-unipile/send-message ─────────────

app.post('/send-message', async (c) => {
	const workspaceId = readWorkspaceIdHeader(c.req)
	if (!workspaceId) {
		return c.json(createApiError('BAD_REQUEST', 'Missing X-Workspace-Id header'), 400)
	}
	let body: { recipient_urn?: unknown; body?: unknown; idempotency_key?: unknown }
	try {
		body = await c.req.json()
	} catch {
		return c.json(createApiError('BAD_REQUEST', 'Invalid JSON in request body'), 400)
	}
	const actorId = c.get('actorId')
	try {
		return c.json(await sendLinkedInMessage({ db: c.get('db'), actorId, workspaceId }, body))
	} catch (err) {
		return handleTerminalError(err, 'send-message', actorId)
	}
})

// ── POST /api/integrations/linkedin-unipile/reply ────────────────────

app.post('/reply', async (c) => {
	const workspaceId = readWorkspaceIdHeader(c.req)
	if (!workspaceId) {
		return c.json(createApiError('BAD_REQUEST', 'Missing X-Workspace-Id header'), 400)
	}
	let body: { thread_id?: unknown; body?: unknown; idempotency_key?: unknown }
	try {
		body = await c.req.json()
	} catch {
		return c.json(createApiError('BAD_REQUEST', 'Invalid JSON in request body'), 400)
	}
	const actorId = c.get('actorId')
	try {
		return c.json(await replyToLinkedInThread({ db: c.get('db'), actorId, workspaceId }, body))
	} catch (err) {
		return handleTerminalError(err, 'reply', actorId)
	}
})

// ── GET /api/integrations/linkedin-unipile/list-conversations ────────

app.get('/list-conversations', async (c) => {
	const workspaceId = readWorkspaceIdHeader(c.req)
	if (!workspaceId) {
		return c.json(createApiError('BAD_REQUEST', 'Missing X-Workspace-Id header'), 400)
	}
	const cursor = c.req.query('cursor') ?? undefined
	const limitRaw = c.req.query('limit')
	const limit = limitRaw ? Number(limitRaw) : undefined
	if (limit !== undefined && (!Number.isFinite(limit) || limit < 1 || limit > 50)) {
		return c.json(
			errorToResponse(
				new LinkedInIntegrationError('INVALID_INPUT', 'limit must be an integer 1..50'),
			),
			400,
		)
	}
	const actorId = c.get('actorId')
	try {
		return c.json(
			await listLinkedInConversations({ db: c.get('db'), actorId, workspaceId }, { limit, cursor }),
		)
	} catch (err) {
		return handleTerminalError(err, 'list-conversations', actorId)
	}
})

export default app

/**
 * Re-exported from `operations.ts`, its new home. Route-level test suites
 * predate the extraction and import the seam from this module; keeping the
 * re-export means the move did not become a test-file rewrite.
 */
export { __setUnipileClientForTests } from '../lib/integrations/providers/linkedin-unipile/operations'
