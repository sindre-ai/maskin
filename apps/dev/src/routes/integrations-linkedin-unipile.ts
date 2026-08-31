import type { Database } from '@maskin/db'
import { idempotencyRecords, integrations } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { decrypt } from '../lib/crypto'
import { createApiError } from '../lib/errors'
import { getIntegrationCredential } from '../lib/integrations/lookup'
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
import { isWorkspaceMember } from '../lib/workspace-auth'

/**
 * LinkedIn (Unipile-backed) MCP-adjacent HTTP routes.
 *
 * Three verbs, one shape: fetch the actor-scoped credential from the
 * `integrations` table (Task 1 introduced the actor_id column + the
 * `getIntegrationCredential` helper), call Unipile via the thin
 * `UnipileClient`, and translate every failure into one of the six
 * `LinkedInIntegrationError` classes before the response leaves this file.
 * The MCP tool wrappers (packages/mcp/src/server.ts) proxy to these routes,
 * so this is the single spot that talks to Unipile, decrypts credentials,
 * or applies the idempotency ledger.
 *
 * NOT a general-purpose facade — every ergonomics decision (retry policy,
 * body redaction on log, idempotency key scoping) sits at this layer so the
 * MCP surface can stay a dumb passthrough.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

type StoredLinkedInCredentials = {
	account_id: string
	account_status?: string
}

const PROVIDER = 'linkedin-unipile'
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

const app = new Hono<Env>()

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
