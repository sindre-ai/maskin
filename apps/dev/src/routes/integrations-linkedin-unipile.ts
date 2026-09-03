import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { idempotencyRecords, integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { trackIntegrationConnected } from '../lib/analytics/integration-events'
import { decrypt, encrypt } from '../lib/crypto'
import { createApiError, validationFailureHook } from '../lib/errors'
import { getIntegrationCredential } from '../lib/integrations/lookup'
import {
	WEBHOOK_HEADER_CANDIDATES,
	createHostedAuthLink,
	verifyWebhookSignature,
} from '../lib/integrations/providers/linkedin-unipile/client'
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
 * LinkedIn (Unipile-backed) integration routes — the whole provider surface.
 *
 * Connect flow (Task 1):
 *   - POST /connect            — creates or looks up a pending integrations row
 *                                keyed by (workspace, actor, provider), calls
 *                                Unipile for a hosted-wizard install URL, and
 *                                returns { install_url } to the UI. Auth: API key.
 *   - POST /callback           — HMAC-SHA256 verify, then in a single Drizzle
 *                                transaction move the pending row to
 *                                status='active' with encrypted { account_id }
 *                                and fire the PostHog integration_connected
 *                                event AFTER the transaction commits. Auth:
 *                                HMAC only (path is exempt from the API-key
 *                                middleware — see app-factory.ts's /callback
 *                                allowlist regex).
 *
 * Message verbs (Task 3), which the MCP tools in packages/mcp/src/server.ts
 * proxy to:
 *   - POST /send-message
 *   - POST /reply
 *   - GET  /list-conversations
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
 * MUST stay `'active'`. Every reader in the codebase filters on that literal —
 * `lib/integrations/lookup.ts`'s `getIntegrationCredential` (the helper this
 * provider's downstream tools use), `oauth/token-manager.ts`, and every
 * `routes/integrations.ts` list query. `integrations.status` is a plain `text`
 * column with no enum or CHECK constraint, so writing any other value is
 * accepted by Postgres and then silently matches nothing on read: the connect
 * flow appears to succeed and the integration is invisible forever.
 */
const CONNECTED_STATUS = 'active'

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
		const cb = callbackUrl()
		const link = await createHostedAuthLink({
			name: integrationId,
			apiUrl: cb,
			notifyUrl: cb,
		})
		return c.json({ install_url: link.url, integration_id: integrationId })
	} catch (err) {
		logger.error('linkedin-unipile connect: hosted-link creation failed', {
			workspaceId,
			actorId,
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to start LinkedIn connect flow'), 500)
	}
}) as RouteHandler<typeof connectRoute, Env>)

// ── POST /callback ─────────────────────────────────────────────────────────

const callbackRoute = createRoute({
	method: 'post',
	path: '/callback',
	tags: ['integrations'],
	summary: 'Unipile Hosted Auth Wizard success callback',
	responses: {
		200: {
			description: 'Callback accepted.',
			content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
		},
		401: {
			description: 'Signature verification failed.',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'No pending integration row matches the callback name.',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(callbackRoute, (async (c) => {
	const db = c.get('db')

	// The raw body is required for HMAC verification, so we read it once and
	// parse it manually. Hono's built-in json parser would consume the stream
	// and force us to re-serialize — which fails to reproduce the exact bytes
	// Unipile signed.
	const rawBody = await c.req.text()

	const provided =
		WEBHOOK_HEADER_CANDIDATES.map((h) => c.req.header(h)).find(
			(v): v is string => typeof v === 'string' && v.length > 0,
		) ?? null

	if (!verifyWebhookSignature(rawBody, provided)) {
		logger.warn('linkedin-unipile callback: signature verification failed', {
			headerPresent: provided !== null,
		})
		return c.json(createApiError('UNAUTHORIZED', 'Invalid webhook signature'), 401)
	}

	let payload: {
		status?: string
		account_id?: string
		name?: string
	} = {}
	try {
		payload = JSON.parse(rawBody) as typeof payload
	} catch {
		return c.json(createApiError('BAD_REQUEST', 'Malformed callback body'), 400)
	}

	if (payload.status !== 'CREATION_SUCCESS' || !payload.account_id || !payload.name) {
		logger.info('linkedin-unipile callback: non-success status or missing fields', {
			status: payload.status,
			hasAccountId: Boolean(payload.account_id),
			hasName: Boolean(payload.name),
		})
		return c.json({ ok: true })
	}

	// The `name` we passed to Unipile at /connect time IS the integrations row id.
	// Look up the pending row by that id and confirm it's still awaiting
	// completion — we deliberately don't fall back to (workspace, actor,
	// provider) because a stale row that was never re-`/connect`'d shouldn't
	// silently absorb an unrelated success.
	const [pending] = await db
		.select()
		.from(integrations)
		.where(and(eq(integrations.id, payload.name), eq(integrations.provider, PROVIDER)))
		.limit(1)

	if (!pending) {
		logger.warn('linkedin-unipile callback: no matching integration row', {
			name: payload.name,
		})
		return c.json(createApiError('NOT_FOUND', 'Unknown integration'), 404)
	}

	const encrypted = encrypt(JSON.stringify({ account_id: payload.account_id }))

	// Single-transaction credential landing — Drizzle's `db.transaction`
	// keeps the UPDATE and any follow-up DDL inside the same txn scope.
	// PostHog capture is intentionally OUTSIDE the transaction: the spec's
	// ordering rule (§Telemetry) is that a rolled-back credential write
	// must never leak a fake integration_connected signal.
	await db.transaction(async (tx) => {
		await tx
			.update(integrations)
			.set({
				credentials: encrypted,
				externalId: payload.account_id,
				status: CONNECTED_STATUS,
				updatedAt: new Date(),
			})
			.where(eq(integrations.id, pending.id))
	})

	// Fire the PostHog signal. `capturePosthogEvent` catches every failure
	// internally so we never mask a successful credential landing with an
	// analytics error.
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

	return c.json({ ok: true })
}) as RouteHandler<typeof callbackRoute, Env>)


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
 * Idempotency dedup path (spec §5). Callers pass an `idempotency_key`
 * scoped to their draft/contact; the server prefixes it with the provider
 * name and actor id so keys never collide across actors or providers. On
 * cache hit, the winner's response is replayed with `replayed: true`. On
 * cache miss, the work runs; the response is persisted, and a concurrent
 * duplicate that lost the primary-key race replays the winner too.
 */
async function withIdempotency<T extends Record<string, unknown>>(opts: {
	db: Database
	actorId: string
	callerKey: string
	method: string
	path: string
	run: () => Promise<T>
}): Promise<T & { replayed: boolean }> {
	const scopedKey = `${IDEMPOTENCY_SCOPE_PREFIX}${opts.actorId}:${opts.callerKey}`
	const cached = await opts.db
		.select()
		.from(idempotencyRecords)
		.where(eq(idempotencyRecords.key, scopedKey))
		.limit(1)
	if (cached[0]) {
		return replayResponse<T>(cached[0].response)
	}
	const fresh = await opts.run()
	try {
		await opts.db.insert(idempotencyRecords).values({
			key: scopedKey,
			actorId: opts.actorId,
			method: opts.method,
			path: opts.path,
			status: 200,
			response: fresh,
		})
		return { ...(fresh as object), replayed: false } as T & { replayed: boolean }
	} catch (err) {
		if (isPrimaryKeyViolation(err)) {
			const winner = await opts.db
				.select()
				.from(idempotencyRecords)
				.where(eq(idempotencyRecords.key, scopedKey))
				.limit(1)
			if (winner[0]) return replayResponse<T>(winner[0].response)
		}
		throw err
	}
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
	const generic = new LinkedInIntegrationError(
		'UNIPILE_UNAVAILABLE',
		'Unexpected upstream error',
		{ cause: err },
	)
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

function normalizeSendResponse(
	body: UnipileSendMessageResponse | Record<string, unknown>,
): { message_id: string; sent_at: string } {
	const rec = body as Record<string, unknown>
	const messageId = typeof rec.id === 'string' ? rec.id : ''
	const sentAt = typeof rec.sent_at === 'string' ? rec.sent_at : new Date().toISOString()
	if (!messageId) {
		throw new LinkedInIntegrationError(
			'UNIPILE_UNAVAILABLE',
			'Unipile response missing message id',
		)
	}
	return { message_id: messageId, sent_at: sentAt }
}

function normalizeListResponse(
	body: UnipileListConversationsResponse | Record<string, unknown>,
): { conversations: UnipileConversation[]; next_cursor?: string } {
	const rec = body as Record<string, unknown>
	const conversations = Array.isArray(rec.conversations)
		? (rec.conversations as UnipileConversation[])
		: []
	const nextCursor = typeof rec.next_cursor === 'string' ? rec.next_cursor : undefined
	return nextCursor ? { conversations, next_cursor: nextCursor } : { conversations }
}

type SendPayload = { recipient_urn: string; body: string; idempotency_key: string }
type ReplyPayload = { thread_id: string; body: string; idempotency_key: string }

function validateSendPayload(
	input: { recipient_urn?: unknown; body?: unknown; idempotency_key?: unknown },
): { ok: true; payload: SendPayload } | { ok: false; error: string } {
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

function validateReplyPayload(
	input: { thread_id?: unknown; body?: unknown; idempotency_key?: unknown },
): { ok: true; payload: ReplyPayload } | { ok: false; error: string } {
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
