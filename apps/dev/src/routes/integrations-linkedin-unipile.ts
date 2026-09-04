import { randomBytes, timingSafeEqual } from 'node:crypto'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	INTEGRATION_STATUS_ACTIVE,
	type Integration,
	idempotencyRecords,
	integrations,
} from '@maskin/db/schema'
import { and, eq, lt } from 'drizzle-orm'
import type { Context } from 'hono'
import { trackIntegrationConnected } from '../lib/analytics/integration-events'
import { decrypt, encrypt } from '../lib/crypto'
import { createApiError, validationFailureHook } from '../lib/errors'
import { getIntegrationCredential } from '../lib/integrations/lookup'
import { createAuthLink } from '../lib/integrations/providers/linkedin-unipile/client'
import {
	LinkedInIntegrationError,
	RETRY_POLICY_BY_CODE,
	classifyUnipileResponse,
	computeBackoffMs,
	delay,
	isAccountStatusRevoked,
	isLinkedInIntegrationError,
} from '../lib/integrations/providers/linkedin-unipile/errors'
import type {
	UnipileClient,
	UnipileConversation,
	UnipileListConversationsResponse,
	UnipileSendMessageResponse,
} from '../lib/integrations/providers/linkedin-unipile/unipile-client'
import { createUnipileHttpClient } from '../lib/integrations/providers/linkedin-unipile/unipile-client'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { isWorkspaceMember } from '../lib/workspace-auth'
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
		return c.json({ install_url: link.data.link, integration_id: integrationId })
	} catch (err) {
		logger.error('linkedin-unipile connect: hosted-link creation failed', {
			workspaceId,
			actorId,
			error: err instanceof Error ? err.message : String(err),
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

type StoredLinkedInCredentials = {
	account_id: string
	account_status?: string
}

const IDEMPOTENCY_SCOPE_PREFIX = `${PROVIDER}:`

type ClientOverride = {
	build: (credentials: StoredLinkedInCredentials) => UnipileClient
}

let clientOverride: ClientOverride | null = null

/**
 * Build (or return the injected) Unipile client. Tests inject a client via
 * `__setUnipileClientForTests` so the routes don't have to touch the real
 * fetch during unit tests.
 */
function buildUnipileClient(credentials: StoredLinkedInCredentials): UnipileClient {
	if (clientOverride) return clientOverride.build(credentials)
	const baseUrl = process.env.UNIPILE_BASE_URL
	const apiKey = process.env.UNIPILE_API_KEY
	if (!baseUrl || !apiKey) {
		throw new LinkedInIntegrationError(
			'UNIPILE_UNAVAILABLE',
			'Unipile client is not configured (missing UNIPILE_BASE_URL or UNIPILE_API_KEY)',
		)
	}
	return createUnipileHttpClient({ baseUrl, apiKey })
}

/**
 * Test-only seam: allow a Vitest suite to replace the client used by the
 * routes without spinning up a fake fetch. Must be reset in `afterEach` of
 * every test that touches it. Not exported from the package's public entry
 * points — only route-level tests should reach in.
 */
export function __setUnipileClientForTests(builder: ClientOverride['build'] | null): void {
	clientOverride = builder === null ? null : { build: builder }
}

/**
 * Shared preamble: workspace-id header, membership check, credential fetch,
 * Unipile client construction. Every handler runs this before hitting the
 * verb-specific logic. Returns a tagged union so handlers can short-circuit
 * on the well-typed error path.
 */
type Preamble =
	| { ok: true; workspaceId: string; actorId: string; credentials: StoredLinkedInCredentials }
	| { ok: false; error: LinkedInIntegrationError }

async function preamble(db: Database, actorId: string, workspaceId: string): Promise<Preamble> {
	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return {
			ok: false,
			error: new LinkedInIntegrationError(
				'CREDENTIAL_NOT_CONNECTED',
				'Actor is not a member of the requested workspace',
			),
		}
	}
	const row = await getIntegrationCredential(db, workspaceId, PROVIDER, actorId)
	if (!row) {
		return {
			ok: false,
			error: new LinkedInIntegrationError(
				'CREDENTIAL_NOT_CONNECTED',
				'No connected LinkedIn account for this actor. Reconnect at Settings > Integrations.',
			),
		}
	}
	let parsed: StoredLinkedInCredentials
	try {
		parsed = JSON.parse(decrypt(row.credentials as string)) as StoredLinkedInCredentials
	} catch (err) {
		return {
			ok: false,
			error: new LinkedInIntegrationError(
				'CREDENTIAL_REVOKED',
				'Stored LinkedIn credentials could not be decrypted',
				{ cause: err },
			),
		}
	}
	if (!parsed.account_id) {
		return {
			ok: false,
			error: new LinkedInIntegrationError(
				'CREDENTIAL_NOT_CONNECTED',
				'Stored LinkedIn credentials are missing account_id',
			),
		}
	}
	if (isAccountStatusRevoked(parsed.account_status)) {
		await markIntegrationRevoked(db, row.id)
		return {
			ok: false,
			error: new LinkedInIntegrationError(
				'CREDENTIAL_REVOKED',
				`LinkedIn account status is ${parsed.account_status}. Reconnect to continue.`,
			),
		}
	}
	return { ok: true, workspaceId, actorId, credentials: parsed }
}

async function markIntegrationRevoked(db: Database, integrationId: string): Promise<void> {
	try {
		await db
			.update(integrations)
			.set({ status: 'revoked' })
			.where(eq(integrations.id, integrationId))
	} catch (err) {
		logger.warn('Failed to flip integration status to revoked', {
			integrationId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Wrap a Unipile call in the retry policy for its error class. Retries only
 * `RATE_LIMITED_UNIPILE` and `UNIPILE_UNAVAILABLE`; everything else is
 * terminal at the first classification. Backoff is exponential with jitter
 * as configured per class in errors.ts.
 *
 * `mutating` marks a call that sends a LinkedIn message. A 5xx/timeout on a
 * send is NOT safe to replay: Unipile may already have handed the message to
 * LinkedIn and failed only on the way back, so a retry inside the single
 * idempotency claim delivers the message twice with the caller seeing one
 * success. 429 stays retryable either way — a rate-limited request is
 * rejected before execution, so replaying it cannot duplicate anything.
 */
async function callUnipileWithRetry<T>(
	call: () => Promise<{ status: number; body: unknown; headers: Record<string, string> }>,
	opts: { mutating?: boolean } = {},
): Promise<{ status: number; body: T; headers: Record<string, string> }> {
	let lastAttemptError: LinkedInIntegrationError | null = null
	for (let attempt = 0; ; attempt++) {
		const result = await call()
		const code = classifyUnipileResponse(result.status, result.body)
		if (code === null) {
			return { status: result.status, body: result.body as T, headers: result.headers }
		}
		const message = extractUpstreamMessage(result.body, code)
		lastAttemptError = new LinkedInIntegrationError(code, message, { httpStatus: result.status })
		const replaySafe = !opts.mutating || code === 'RATE_LIMITED_UNIPILE'
		const policy = replaySafe ? RETRY_POLICY_BY_CODE[code] : null
		if (!policy || attempt + 1 >= policy.maxAttempts) {
			throw lastAttemptError
		}
		// A silent retry loop makes a duplicate undiagnosable after the fact.
		logger.warn('linkedin-unipile: retrying upstream call', {
			code,
			attempt: attempt + 1,
			maxAttempts: policy.maxAttempts,
		})
		await delay(computeBackoffMs(policy, attempt))
	}
}

function extractUpstreamMessage(body: unknown, code: string): string {
	if (body && typeof body === 'object') {
		const rec = body as Record<string, unknown>
		if (typeof rec.message === 'string' && rec.message.length > 0) return rec.message
		if (typeof rec.error === 'string' && rec.error.length > 0) return rec.error
		const detail = rec.detail
		if (typeof detail === 'string' && detail.length > 0) return detail
	}
	return `Unipile responded with ${code}`
}

/**
 * Sentinel `status` for a claim row whose work is still running. Real
 * responses are persisted with the HTTP status they carried (200), so 0 is
 * unambiguous and needs no extra column.
 */
const IN_FLIGHT_STATUS = 0

/**
 * How long a claim row may sit in-flight before another request may take it
 * over. A send is bounded well under this: `callUnipileWithRetry` caps at 3
 * attempts with a 30s backoff ceiling, so the worst realistic case is ~1
 * minute. A row still claimed after five minutes therefore means the original
 * process died between claiming and recording, and the key would otherwise be
 * poisoned until the nightly purge.
 */
const IN_FLIGHT_CLAIM_TTL_MS = 5 * 60 * 1000

/**
 * Idempotency dedup path (spec §5). Callers pass an `idempotency_key` scoped
 * to their draft/contact; the server prefixes it with the provider name, the
 * actor id, and the verb so keys never collide across actors, providers, or
 * operations.
 *
 * The verb is part of the key on purpose. `buildLinkedinAutosendIdempotencyKey`
 * mints `{contact_id}:{draft_id}`, and the same (contact, draft) pair recurs
 * across a send and a later reply — with a verb-blind key the reply would
 * replay the send's stored response, report success, and never be delivered.
 *
 * CLAIM BEFORE WORK. The row is inserted *before* `run()` executes, not after.
 * The natural ordering — SELECT, run, INSERT — is check-then-act: two
 * concurrent calls with the same key both miss the SELECT, both perform the
 * side effect, and the one that loses the primary-key race reports
 * `replayed: true` having already sent a second LinkedIn message. Since the
 * whole point of the ledger is that a send happens at most once, the claim has
 * to be what serialises the callers, and the primary key is what makes the
 * claim atomic.
 *
 * Three outcomes on a duplicate:
 *   - winner finished → replay its stored response.
 *   - winner still in flight → surface a retryable error. We must not run,
 *     because that is the duplicate send this function exists to prevent.
 *   - winner's claim is older than the TTL → take it over (guarded by a
 *     conditional UPDATE, so two simultaneous takeovers can't both win).
 */
async function withIdempotency<T extends Record<string, unknown>>(opts: {
	db: Database
	actorId: string
	callerKey: string
	method: string
	path: string
	run: () => Promise<T>
}): Promise<T & { replayed: boolean }> {
	const scopedKey = `${IDEMPOTENCY_SCOPE_PREFIX}${opts.actorId}:${opts.method}:${opts.path}:${opts.callerKey}`

	let claimed = false
	try {
		await opts.db.insert(idempotencyRecords).values({
			key: scopedKey,
			actorId: opts.actorId,
			method: opts.method,
			path: opts.path,
			status: IN_FLIGHT_STATUS,
			response: {},
		})
		claimed = true
	} catch (err) {
		if (!isPrimaryKeyViolation(err)) throw err
	}

	if (!claimed) {
		const [winner] = await opts.db
			.select()
			.from(idempotencyRecords)
			.where(eq(idempotencyRecords.key, scopedKey))
			.limit(1)

		// Gone between the failed insert and this read — purged, or the owner
		// released it after a failure. Treat as retryable rather than racing again.
		if (!winner) {
			throw new LinkedInIntegrationError(
				'UNIPILE_UNAVAILABLE',
				'Idempotency claim vanished mid-flight. Retry the request.',
			)
		}

		if (winner.status !== IN_FLIGHT_STATUS) {
			return replayResponse<T>(winner.response)
		}

		const staleCutoff = new Date(Date.now() - IN_FLIGHT_CLAIM_TTL_MS)
		const takenOver = await opts.db
			.update(idempotencyRecords)
			.set({ createdAt: new Date() })
			.where(
				and(
					eq(idempotencyRecords.key, scopedKey),
					eq(idempotencyRecords.status, IN_FLIGHT_STATUS),
					lt(idempotencyRecords.createdAt, staleCutoff),
				),
			)
			.returning({ key: idempotencyRecords.key })

		if (takenOver.length === 0) {
			// Another request holds a live claim. Refusing here is the entire
			// point: proceeding would send the message a second time.
			throw new LinkedInIntegrationError(
				'UNIPILE_UNAVAILABLE',
				'A request with this idempotency key is already in flight. Retry shortly.',
			)
		}
		logger.warn('Took over a stale LinkedIn idempotency claim', {
			actorId: opts.actorId,
			method: opts.method,
			path: opts.path,
		})
	}

	let fresh: T
	try {
		fresh = await opts.run()
	} catch (err) {
		// Release the claim so a retry isn't blocked by work that never
		// produced a side effect to dedup. Best-effort: if this fails the row
		// simply ages out via the TTL above.
		try {
			await opts.db.delete(idempotencyRecords).where(eq(idempotencyRecords.key, scopedKey))
		} catch (releaseErr) {
			logger.warn('Failed to release LinkedIn idempotency claim after an error', {
				actorId: opts.actorId,
				error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
			})
		}
		throw err
	}

	try {
		await opts.db
			.update(idempotencyRecords)
			.set({ status: 200, response: fresh, createdAt: new Date() })
			.where(eq(idempotencyRecords.key, scopedKey))
	} catch (err) {
		// The side effect already happened. Do NOT rethrow — that would hand
		// the caller a failure for work that succeeded and invite a retry that
		// re-sends. The claim row stays in-flight and blocks duplicates until
		// it ages out, which is the safe direction to fail.
		logger.error('LinkedIn send succeeded but its idempotency record was not persisted', {
			actorId: opts.actorId,
			method: opts.method,
			path: opts.path,
			error: err instanceof Error ? err.message : String(err),
		})
	}
	return { ...(fresh as object), replayed: false } as T & { replayed: boolean }
}

function replayResponse<T extends Record<string, unknown>>(
	stored: unknown,
): T & { replayed: boolean } {
	const body = (stored && typeof stored === 'object' ? stored : {}) as T
	return { ...(body as object), replayed: true } as T & { replayed: boolean }
}

/**
 * Postgres primary-key / unique-index violation detection. The postgres-js
 * driver surfaces `err.code === '23505'` (SQLSTATE for unique_violation);
 * drizzle re-throws that error object unchanged. We only need the SQLSTATE
 * check — the constraint name isn't stable across environments.
 */
function isPrimaryKeyViolation(err: unknown): boolean {
	if (!err || typeof err !== 'object') return false
	const rec = err as Record<string, unknown>
	if (rec.code === '23505') return true
	const cause = rec.cause as Record<string, unknown> | undefined
	if (cause && cause.code === '23505') return true
	return false
}

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
	const db = c.get('db')
	const actorId = c.get('actorId')
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
	const validation = validateSendPayload(body)
	if (!validation.ok) {
		return c.json(
			errorToResponse(new LinkedInIntegrationError('INVALID_INPUT', validation.error)),
			400,
		)
	}
	const pre = await preamble(db, actorId, workspaceId)
	if (!pre.ok) return handleTerminalError(pre.error, 'send-message', actorId)
	try {
		const client = buildUnipileClient(pre.credentials)
		const result = await withIdempotency({
			db,
			actorId,
			callerKey: validation.payload.idempotency_key,
			method: 'POST',
			path: '/api/integrations/linkedin-unipile/send-message',
			run: async () => {
				const upstream = await callUnipileWithRetry<
					UnipileSendMessageResponse | Record<string, unknown>
				>(
					() =>
						client.sendMessage({
							account_id: pre.credentials.account_id,
							recipient_urn: validation.payload.recipient_urn,
							body: validation.payload.body,
						}),
					{ mutating: true },
				)
				return normalizeSendResponse(upstream.body)
			},
		})
		return c.json(result)
	} catch (err) {
		return handleTerminalError(err, 'send-message', actorId)
	}
})

// ── POST /api/integrations/linkedin-unipile/reply ────────────────────

app.post('/reply', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
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
	const validation = validateReplyPayload(body)
	if (!validation.ok) {
		return c.json(
			errorToResponse(new LinkedInIntegrationError('INVALID_INPUT', validation.error)),
			400,
		)
	}
	const pre = await preamble(db, actorId, workspaceId)
	if (!pre.ok) return handleTerminalError(pre.error, 'reply', actorId)
	try {
		const client = buildUnipileClient(pre.credentials)
		const result = await withIdempotency({
			db,
			actorId,
			callerKey: validation.payload.idempotency_key,
			method: 'POST',
			path: '/api/integrations/linkedin-unipile/reply',
			run: async () => {
				const upstream = await callUnipileWithRetry<
					UnipileSendMessageResponse | Record<string, unknown>
				>(
					() =>
						client.reply({
							account_id: pre.credentials.account_id,
							thread_id: validation.payload.thread_id,
							body: validation.payload.body,
						}),
					{ mutating: true },
				)
				return normalizeSendResponse(upstream.body)
			},
		})
		return c.json(result)
	} catch (err) {
		return handleTerminalError(err, 'reply', actorId)
	}
})

// ── GET /api/integrations/linkedin-unipile/list-conversations ────────
// Reads only — NOT idempotency-tracked (spec §5 residual: reads don't need
// dedup, only mutating verbs do).

app.get('/list-conversations', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
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
	const pre = await preamble(db, actorId, workspaceId)
	if (!pre.ok) return handleTerminalError(pre.error, 'list-conversations', actorId)
	try {
		const client = buildUnipileClient(pre.credentials)
		const upstream = await callUnipileWithRetry<
			UnipileListConversationsResponse | Record<string, unknown>
		>(() =>
			client.listConversations({
				account_id: pre.credentials.account_id,
				cursor,
				limit,
			}),
		)
		return c.json(normalizeListResponse(upstream.body))
	} catch (err) {
		return handleTerminalError(err, 'list-conversations', actorId)
	}
})

/**
 * Unipile v2 send responses, per the reference pages:
 *   - start-chat  POST /v2/{account}/chats/send          → { object: 'ChatStarted', chat_id, message_id }
 *   - in-chat     POST /v2/{account}/chats/{id}/messages/send → { object: 'MessageSent', message_id }
 *
 * `message_id` is documented as `string | string[] | null` — an array when
 * attachments go out as separate messages, null when no message was sent.
 */
function normalizeSendResponse(body: UnipileSendMessageResponse | Record<string, unknown>): {
	message_id: string
	chat_id?: string
	sent_at: string
} {
	const rec = body as Record<string, unknown>
	const inner =
		rec.data && typeof rec.data === 'object' ? (rec.data as Record<string, unknown>) : rec
	const raw = inner.message_id ?? inner.id
	const messageId =
		typeof raw === 'string' ? raw : Array.isArray(raw) && typeof raw[0] === 'string' ? raw[0] : ''
	const chatId = typeof inner.chat_id === 'string' ? inner.chat_id : undefined
	const sentAt = typeof inner.sent_at === 'string' ? inner.sent_at : new Date().toISOString()

	if (!messageId) {
		// We got here on a 2xx: LinkedIn ACCEPTED the message. Throwing a
		// retryable error here would release the idempotency claim and let the
		// caller send a SECOND copy — the duplicate-outreach pattern that gets
		// LinkedIn accounts restricted. An unreadable id is a success we cannot
		// fully describe, not a failure: report it, and log loudly enough that
		// a real envelope drift is diagnosable.
		logger.error('linkedin-unipile send: 2xx with no readable message id', {
			responseKeys: Object.keys(inner),
		})
	}
	return { message_id: messageId, sent_at: sentAt, ...(chatId ? { chat_id: chatId } : {}) }
}

/**
 * A single chat in a v2 `GET /v2/{account}/chats` response. Field names are
 * from the v2 reference — v1's `thread_id`/`attendees` are gone: the id is
 * `id`, the timestamp is `last_message_timestamp`, and booleans are `is_*`.
 * Unknown keys pass through so a Unipile addition can't fail the parse.
 */
const V2ChatSchema = z
	.object({
		id: z.string(),
		name: z.string().optional(),
		user_id: z.string().optional(),
		last_message_timestamp: z.string().optional(),
		unread_count: z.number().optional(),
		last_message: z.object({ text: z.string().optional() }).passthrough().nullish(),
	})
	.passthrough()

/**
 * Map v2 wire chats onto the MCP-facing conversation shape. The MCP contract
 * (`thread_id`, `participants`, …) is deliberately unchanged — agents see the
 * same fields; only the translation from the wire moved to v2.
 *
 * `participants` is populated from `user_id`, which v2 sets on 1-to-1 chats
 * only. Group chats carry `participants_count` but no member list on this
 * endpoint, so they map to an empty array rather than a fabricated one.
 */
function normalizeListResponse(body: UnipileListConversationsResponse | Record<string, unknown>): {
	conversations: UnipileConversation[]
	next_cursor?: string
} {
	const rec = body as Record<string, unknown>
	// v2 nests the page under `data`. `conversations`/`items` are kept as
	// tolerated aliases only so a tenant on an older build doesn't hard-fail.
	const arr = Array.isArray(rec.data)
		? rec.data
		: Array.isArray(rec.items)
			? rec.items
			: Array.isArray(rec.conversations)
				? rec.conversations
				: null

	if (arr === null) {
		// A read has no side effect, so failing loudly is safe — and far better
		// than handing an agent an empty inbox it will report as "no messages".
		logger.error('linkedin-unipile list: no conversation array in response', {
			responseKeys: Object.keys(rec),
		})
		throw new LinkedInIntegrationError(
			'UNIPILE_UNAVAILABLE',
			'Unipile conversation list had an unrecognised shape',
		)
	}

	const conversations: UnipileConversation[] = []
	let skipped = 0
	for (const item of arr) {
		const parsed = V2ChatSchema.safeParse(item)
		if (!parsed.success) {
			skipped++
			continue
		}
		const chat = parsed.data
		conversations.push({
			thread_id: chat.id,
			participants: chat.user_id
				? [{ recipient_urn: chat.user_id, display_name: chat.name ?? '' }]
				: [],
			last_message_at: chat.last_message_timestamp ?? '',
			unread_count: chat.unread_count ?? 0,
			preview: chat.last_message?.text ?? '',
		})
	}
	if (skipped > 0) {
		// Dropping silently would look like a short page to the caller.
		logger.warn('linkedin-unipile list: dropped unparseable chats', {
			skipped,
			total: arr.length,
		})
	}

	const nextCursor =
		typeof rec.next_cursor === 'string'
			? rec.next_cursor
			: typeof rec.cursor === 'string'
				? rec.cursor
				: undefined
	return nextCursor ? { conversations, next_cursor: nextCursor } : { conversations }
}

type SendPayload = { recipient_urn: string; body: string; idempotency_key: string }
type ReplyPayload = { thread_id: string; body: string; idempotency_key: string }

function validateSendPayload(input: {
	recipient_urn?: unknown
	body?: unknown
	idempotency_key?: unknown
}): { ok: true; payload: SendPayload } | { ok: false; error: string } {
	if (typeof input.recipient_urn !== 'string' || input.recipient_urn.length === 0) {
		return { ok: false, error: 'recipient_urn is required' }
	}
	if (typeof input.body !== 'string' || input.body.length === 0 || input.body.length > 8000) {
		return { ok: false, error: 'body must be a non-empty string, max 8000 chars' }
	}
	if (
		typeof input.idempotency_key !== 'string' ||
		input.idempotency_key.length === 0 ||
		input.idempotency_key.length > 128
	) {
		return { ok: false, error: 'idempotency_key must be a non-empty string, max 128 chars' }
	}
	return {
		ok: true,
		payload: {
			recipient_urn: input.recipient_urn,
			body: input.body,
			idempotency_key: input.idempotency_key,
		},
	}
}

function validateReplyPayload(input: {
	thread_id?: unknown
	body?: unknown
	idempotency_key?: unknown
}): { ok: true; payload: ReplyPayload } | { ok: false; error: string } {
	if (typeof input.thread_id !== 'string' || input.thread_id.length === 0) {
		return { ok: false, error: 'thread_id is required' }
	}
	if (typeof input.body !== 'string' || input.body.length === 0 || input.body.length > 8000) {
		return { ok: false, error: 'body must be a non-empty string, max 8000 chars' }
	}
	if (
		typeof input.idempotency_key !== 'string' ||
		input.idempotency_key.length === 0 ||
		input.idempotency_key.length > 128
	) {
		return { ok: false, error: 'idempotency_key must be a non-empty string, max 128 chars' }
	}
	return {
		ok: true,
		payload: {
			thread_id: input.thread_id,
			body: input.body,
			idempotency_key: input.idempotency_key,
		},
	}
}

export default app
