import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { INTEGRATION_STATUS_ACTIVE, idempotencyRecords, integrations } from '@maskin/db/schema'
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

	let integrationId: string
	if (existing[0]) {
		integrationId = existing[0].id
		// 'active' is the shared vocabulary — see CONNECTED_STATUS. Re-running
		// the wizard against an already-active row must NOT demote it to
		// pending, or the credential goes unreadable until the callback lands.
		if (existing[0].status !== CONNECTED_STATUS) {
			await db
				.update(integrations)
				.set({ status: 'pending', updatedAt: new Date() })
				.where(eq(integrations.id, integrationId))
		}
	} else {
		const [row] = await db
			.insert(integrations)
			.values({
				workspaceId,
				actorId,
				provider: PROVIDER,
				status: 'pending',
				credentials: '',
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
			state: integrationId,
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

	// `state` IS integrations.id — we set it at /connect time. A stale row
	// that was never re-connected must not silently absorb an unrelated success.
	const [pending] = await db
		.select()
		.from(integrations)
		.where(and(eq(integrations.id, state), eq(integrations.provider, PROVIDER)))
		.limit(1)

	if (!pending) {
		logger.warn('linkedin-unipile callback: no matching integration row', { state })
		return redirectToSettings(c, 'error', 'unknown_state')
	}

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

	return redirectToSettings(c, 'connected', account_id)
}) as RouteHandler<typeof callbackRoute, Env>)

function settingsIntegrationsUrl(): string {
	const base = (process.env.MASKIN_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '')
	return `${base}/settings/integrations`
}

function redirectToSettings(c: Context, status: 'connected' | 'error', detail: string): Response {
	const url = new URL(settingsIntegrationsUrl())
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
		const [pending] = await db
			.select()
			.from(integrations)
			.where(and(eq(integrations.id, state), eq(integrations.provider, PROVIDER)))
			.limit(1)
		if (pending) {
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
			return redirectToSettings(c, 'connected', error_detail)
		}
		logger.warn('linkedin-unipile callback already_exists: no pending row for state', { state })
		return redirectToSettings(c, 'error', 'unknown_state')
	}

	if (error_type === 'api/restricted_account') {
		return redirectToSettings(c, 'error', 'account_restricted')
	}
	logger.warn('linkedin-unipile callback: unknown error_type', { error_type, state })
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
 */
async function callUnipileWithRetry<T>(
	call: () => Promise<{ status: number; body: unknown; headers: Record<string, string> }>,
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
		const policy = RETRY_POLICY_BY_CODE[code]
		if (!policy || attempt + 1 >= policy.maxAttempts) {
			throw lastAttemptError
		}
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
				>(() =>
					client.sendMessage({
						account_id: pre.credentials.account_id,
						recipient_urn: validation.payload.recipient_urn,
						body: validation.payload.body,
					}),
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
				>(() =>
					client.reply({
						account_id: pre.credentials.account_id,
						thread_id: validation.payload.thread_id,
						body: validation.payload.body,
					}),
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

function normalizeSendResponse(body: UnipileSendMessageResponse | Record<string, unknown>): {
	message_id: string
	sent_at: string
} {
	const rec = body as Record<string, unknown>
	// The v2 migration doc confirms account_id moves to the path but does not
	// fully spec the response envelope. Accept either `id` or `message_id`;
	// default `sent_at` to now so a response missing the timestamp doesn't 502
	// on the caller. The MCP tool contract (Task 3 Zod schemas) stays stable.
	const inner =
		rec.data && typeof rec.data === 'object' ? (rec.data as Record<string, unknown>) : rec
	const messageIdRaw =
		typeof inner.message_id === 'string'
			? inner.message_id
			: typeof inner.id === 'string'
				? inner.id
				: ''
	const sentAtRaw = typeof inner.sent_at === 'string' ? inner.sent_at : new Date().toISOString()
	if (!messageIdRaw) {
		throw new LinkedInIntegrationError('UNIPILE_UNAVAILABLE', 'Unipile response missing message id')
	}
	return { message_id: messageIdRaw, sent_at: sentAtRaw }
}

function normalizeListResponse(body: UnipileListConversationsResponse | Record<string, unknown>): {
	conversations: UnipileConversation[]
	next_cursor?: string
} {
	const rec = body as Record<string, unknown>
	// v2 envelope isn't fully documented; try `conversations`, `items`, `data`
	// in order and take the first array we find. Pagination is `cursor` or
	// `next_cursor` — treat both as opaque strings the caller feeds back.
	const arr = Array.isArray(rec.conversations)
		? rec.conversations
		: Array.isArray(rec.items)
			? rec.items
			: Array.isArray(rec.data)
				? rec.data
				: []
	const conversations = arr as UnipileConversation[]
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
