import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { idempotencyRecords, integrations, linkedinToolCalls } from '@maskin/db/schema'
import { and, eq, lt } from 'drizzle-orm'
import { z } from 'zod'
import { decrypt } from '../../../crypto'
import { logger } from '../../../logger'
import { isWorkspaceMember } from '../../../workspace-auth'
import { getIntegrationCredential } from '../../lookup'
import {
	LinkedInIntegrationError,
	RETRY_POLICY_BY_CODE,
	classifyUnipileResponse,
	computeBackoffMs,
	delay,
	isAccountStatusRevoked,
} from './errors'
import type {
	UnipileClient,
	UnipileConnectionRequestResponse,
	UnipileConversation,
	UnipileListConversationsResponse,
	UnipileSendMessageResponse,
} from './unipile-client'
import { createUnipileHttpClient } from './unipile-client'

/**
 * Provider-side operations for the LinkedIn (Unipile-backed) message verbs.
 *
 * These were extracted from `routes/integrations-linkedin-unipile.ts` when
 * LinkedIn gained its own MCP server: the REST routes and the in-process MCP
 * server (`mcp-server.ts`) are two callers of the same three operations, and
 * the credential lookup, six-class error taxonomy, retry policy and
 * idempotency dedup must not be reimplemented per caller. The route file
 * keeps only the HTTP shell (header parsing, status mapping); everything that
 * decides what happens lives here.
 *
 * Every operation is actor-scoped: LinkedIn credentials are keyed by
 * (workspace, actor, provider), so the calling actor's own connected identity
 * is the one that sends. This is deliberately unlike Slack, whose bot token is
 * workspace-wide.
 */

const PROVIDER = 'linkedin-unipile'

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
	// `fallbackToAnyActor`: an agent has no LinkedIn connection of its own and
	// never will — it does not go through the connect flow — so a strict
	// actor-scoped read makes the credential unreachable from the MCP tools
	// that exist to use it. A human connects; every agent in the workspace can
	// send, exactly as they can with Gmail or Slack.
	const row = await getIntegrationCredential(db, workspaceId, PROVIDER, actorId, {
		fallbackToAnyActor: true,
	})
	if (!row) {
		return {
			ok: false,
			error: new LinkedInIntegrationError(
				'CREDENTIAL_NOT_CONNECTED',
				'No LinkedIn account is connected in this workspace. Connect one at Settings > Integrations.',
			),
		}
	}
	if (row.actorId && row.actorId !== actorId) {
		// Whose LinkedIn a message went out as is the first thing anyone will
		// ask after an agent sends something unexpected. Record it.
		logger.info('LinkedIn call using another actor’s connected identity', {
			workspaceId,
			callerActorId: actorId,
			identityActorId: row.actorId,
			integrationId: row.id,
		})
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
		// 501 lands in the 5xx band and so classifies as UNIPILE_UNAVAILABLE,
		// but "not implemented" is a permanent statement about the route, not a
		// transient outage. Retrying it burns three attempts and ~9s of backoff
		// to arrive at the same answer, and buries the one useful thing in the
		// response — which endpoint to call instead — under a retry storm.
		const permanent = result.status === 501
		const policy = replaySafe && !permanent ? RETRY_POLICY_BY_CODE[code] : null
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

/**
 * Pull the page array out of a v2 read response, or throw.
 *
 * Shared by every paged read below. A read has no side effect, so failing
 * loudly on an unrecognised shape is safe — and far better than returning an
 * empty array, which an agent reports as "you have no connections" rather than
 * "the call did not work". This is the same reasoning as
 * `normalizeListResponse`, factored out so the four newer reads cannot drift
 * from it.
 */
function readPage(body: unknown, what: string): { items: unknown[]; nextCursor?: string } {
	const rec = (body ?? {}) as Record<string, unknown>
	if (!Array.isArray(rec.data)) {
		logger.error(`linkedin-unipile ${what}: no data array in response`, {
			responseKeys: Object.keys(rec),
		})
		throw new LinkedInIntegrationError(
			'UNIPILE_UNAVAILABLE',
			`Unipile ${what} response had an unrecognised shape`,
		)
	}
	const nextCursor = typeof rec.next_cursor === 'string' ? rec.next_cursor : undefined
	return { items: rec.data, nextCursor }
}

/** MCP-facing message shape. Ours, not Unipile's — see `UnipileConversation`. */
export type LinkedInMessage = {
	message_id: string
	text: string
	sent_at: string
	sender_urn: string
	/** True when the connected account sent it — lets an agent tell sides apart. */
	from_me: boolean
}

const V2MessageSchema = z
	.object({
		id: z.string(),
		text: z.string().nullish(),
		timestamp: z.string().optional(),
		sender_id: z.string().optional(),
		is_sender: z.union([z.boolean(), z.number()]).optional(),
	})
	.passthrough()

function normalizeMessages(body: unknown): {
	messages: LinkedInMessage[]
	next_cursor?: string
} {
	const { items, nextCursor } = readPage(body, 'messages')
	const messages: LinkedInMessage[] = []
	let skipped = 0
	for (const item of items) {
		const parsed = V2MessageSchema.safeParse(item)
		if (!parsed.success) {
			skipped++
			continue
		}
		const m = parsed.data
		messages.push({
			message_id: m.id,
			text: m.text ?? '',
			sent_at: m.timestamp ?? '',
			sender_urn: m.sender_id ?? '',
			// v2 sends `is_sender` as 0/1 on some payloads and a boolean on
			// others; Boolean() reads both the same way.
			from_me: Boolean(m.is_sender),
		})
	}
	if (skipped > 0) {
		logger.warn('linkedin-unipile messages: dropped unparseable rows', {
			skipped,
			total: items.length,
		})
	}
	return nextCursor ? { messages, next_cursor: nextCursor } : { messages }
}

/** MCP-facing person shape, shared by connections / search / profile. */
export type LinkedInPerson = {
	/** Pass as `recipient_urn` to linkedin_send_message. */
	recipient_urn: string
	name: string
	headline: string
	profile_url: string
	/** "janedoe" — the handle in a linkedin.com/in/<handle> URL. */
	public_identifier: string
	/**
	 * FIRST_DEGREE / SECOND_DEGREE / THIRD_DEGREE where the provider says so.
	 * Empty for connections (always first-degree by definition). Matters
	 * because a non-connection usually cannot be DM'd without an invitation.
	 */
	network_distance: string
	location: string
}

const V2PersonSchema = z
	.object({
		id: z.string().optional(),
		display_name: z.string().optional(),
		first_name: z.string().optional(),
		last_name: z.string().optional(),
		headline: z.string().nullish(),
		description: z.string().nullish(),
		profile_url: z.string().nullish(),
		public_identifier: z.string().nullish(),
		network_distance: z.string().nullish(),
		location: z.string().nullish(),
	})
	.passthrough()

function toPerson(raw: unknown): LinkedInPerson | null {
	const parsed = V2PersonSchema.safeParse(raw)
	if (!parsed.success) return null
	const p = parsed.data
	// No id means nothing can be done with the row — it cannot be messaged and
	// cannot be looked up again, so it is dropped rather than half-populated.
	const id = p.id
	if (!id) return null
	const name =
		p.display_name?.trim() || [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || ''
	return {
		recipient_urn: id,
		name,
		// `headline` on a search result, `description` on a relation/profile —
		// same idea under two names depending on which endpoint answered.
		headline: p.headline ?? p.description ?? '',
		profile_url: p.profile_url ?? '',
		public_identifier: p.public_identifier ?? '',
		network_distance: p.network_distance ?? '',
		location: p.location ?? '',
	}
}

function normalizePeople(
	body: unknown,
	what: string,
	/** Relations nest the person under `user`; search returns it flat. */
	unwrap?: (item: unknown) => unknown,
): { people: LinkedInPerson[]; next_cursor?: string } {
	const { items, nextCursor } = readPage(body, what)
	const people: LinkedInPerson[] = []
	let skipped = 0
	for (const item of items) {
		const person = toPerson(unwrap ? unwrap(item) : item)
		if (!person) {
			skipped++
			continue
		}
		people.push(person)
	}
	if (skipped > 0) {
		logger.warn(`linkedin-unipile ${what}: dropped unparseable rows`, {
			skipped,
			total: items.length,
		})
	}
	return nextCursor ? { people, next_cursor: nextCursor } : { people }
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

// ── Operations ────────────────────────────────────────────────────────────
// The three verbs, caller-agnostic. Each returns a plain object on success
// and throws a `LinkedInIntegrationError` on any terminal failure, so an HTTP
// caller can map `err.httpStatus` and an MCP caller can map `err.code` to the
// six-class taxonomy without either knowing about the other.

export interface LinkedInOperationContext {
	db: Database
	actorId: string
	workspaceId: string
}

export async function sendLinkedInMessage(
	ctx: LinkedInOperationContext,
	input: { recipient_urn?: unknown; body?: unknown; idempotency_key?: unknown },
): Promise<{ message_id: string; chat_id?: string; sent_at: string }> {
	const validation = validateSendPayload(input)
	if (!validation.ok) {
		throw new LinkedInIntegrationError('INVALID_INPUT', validation.error)
	}
	const pre = await preamble(ctx.db, ctx.actorId, ctx.workspaceId)
	if (!pre.ok) throw pre.error
	const client = buildUnipileClient(pre.credentials)
	return withIdempotency({
		db: ctx.db,
		actorId: ctx.actorId,
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
}

export async function replyToLinkedInThread(
	ctx: LinkedInOperationContext,
	input: { thread_id?: unknown; body?: unknown; idempotency_key?: unknown },
): Promise<{ message_id: string; chat_id?: string; sent_at: string }> {
	const validation = validateReplyPayload(input)
	if (!validation.ok) {
		throw new LinkedInIntegrationError('INVALID_INPUT', validation.error)
	}
	const pre = await preamble(ctx.db, ctx.actorId, ctx.workspaceId)
	if (!pre.ok) throw pre.error
	const client = buildUnipileClient(pre.credentials)
	return withIdempotency({
		db: ctx.db,
		actorId: ctx.actorId,
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
}

/**
 * Reads are NOT idempotency-tracked — only mutating verbs need dedup
 * (spec §5).
 */
export async function listLinkedInConversations(
	ctx: LinkedInOperationContext,
	input: { limit?: number; cursor?: string } = {},
): Promise<{ conversations: unknown[]; next_cursor?: string }> {
	const pre = await preamble(ctx.db, ctx.actorId, ctx.workspaceId)
	if (!pre.ok) throw pre.error
	const client = buildUnipileClient(pre.credentials)
	const upstream = await callUnipileWithRetry<
		UnipileListConversationsResponse | Record<string, unknown>
	>(() =>
		client.listConversations({
			account_id: pre.credentials.account_id,
			limit: input.limit,
			cursor: input.cursor,
		}),
	)
	return normalizeListResponse(upstream.body)
}

/**
 * Read the messages in one conversation, newest-first, paged.
 *
 * `list_conversations` only returns a one-line preview per thread; this is how
 * an agent reads what was actually said before replying. Read-only, so no
 * idempotency key (spec §5 — only mutating verbs need dedup).
 */
export async function listLinkedInMessages(
	ctx: LinkedInOperationContext,
	input: { thread_id?: unknown; limit?: number; cursor?: string },
): Promise<{ messages: LinkedInMessage[]; next_cursor?: string }> {
	const threadId = typeof input.thread_id === 'string' ? input.thread_id.trim() : ''
	if (!threadId) {
		throw new LinkedInIntegrationError('INVALID_INPUT', 'thread_id is required')
	}
	const pre = await preamble(ctx.db, ctx.actorId, ctx.workspaceId)
	if (!pre.ok) throw pre.error
	const client = buildUnipileClient(pre.credentials)
	const upstream = await callUnipileWithRetry<Record<string, unknown>>(() =>
		client.listMessages({
			account_id: pre.credentials.account_id,
			chat_id: threadId,
			limit: input.limit,
			cursor: input.cursor,
		}),
	)
	return normalizeMessages(upstream.body)
}

/**
 * List the connected account's LinkedIn connections (first-degree).
 *
 * Note this is `/users/me/relations` in the client, NOT `/users/relations` —
 * the latter resolves as a profile lookup and answers 200 with one unrelated
 * person.
 */
export async function listLinkedInConnections(
	ctx: LinkedInOperationContext,
	input: { limit?: number; cursor?: string } = {},
): Promise<{ people: LinkedInPerson[]; next_cursor?: string }> {
	const pre = await preamble(ctx.db, ctx.actorId, ctx.workspaceId)
	if (!pre.ok) throw pre.error
	const client = buildUnipileClient(pre.credentials)
	const upstream = await callUnipileWithRetry<Record<string, unknown>>(() =>
		client.listRelations({
			account_id: pre.credentials.account_id,
			limit: input.limit,
			cursor: input.cursor,
		}),
	)
	// A relation wraps the person under `user`; search returns them flat.
	return normalizePeople(upstream.body, 'connections', (item) =>
		item && typeof item === 'object' ? ((item as Record<string, unknown>).user ?? item) : item,
	)
}

/**
 * Open people search across LinkedIn.
 *
 * Results are whatever LinkedIn's own people search returns for the connected
 * member — subject to their visibility — so most hits are 2nd/3rd degree and
 * NOT directly messageable. `network_distance` on each result is what tells
 * the agent that, which is why it is on the shared person shape.
 */
export async function searchLinkedInPeople(
	ctx: LinkedInOperationContext,
	input: { keywords?: unknown; search_url?: unknown; limit?: number; cursor?: string },
): Promise<{ people: LinkedInPerson[]; next_cursor?: string }> {
	const keywords = typeof input.keywords === 'string' ? input.keywords.trim() : ''
	const searchUrl = typeof input.search_url === 'string' ? input.search_url.trim() : ''
	if (!keywords && !searchUrl) {
		throw new LinkedInIntegrationError('INVALID_INPUT', 'Provide keywords or search_url')
	}
	// Reject a non-LinkedIn URL rather than posting it upstream: `search_url`
	// is caller-supplied and goes into a request we make with the customer's
	// credential, so it must not become a way to point that request elsewhere.
	if (searchUrl && !/^https:\/\/(www\.)?linkedin\.com\//i.test(searchUrl)) {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			'search_url must be a https://www.linkedin.com/ search URL',
		)
	}
	const pre = await preamble(ctx.db, ctx.actorId, ctx.workspaceId)
	if (!pre.ok) throw pre.error
	const client = buildUnipileClient(pre.credentials)
	const upstream = await callUnipileWithRetry<Record<string, unknown>>(() =>
		client.searchPeople({
			account_id: pre.credentials.account_id,
			keywords: keywords || undefined,
			url: searchUrl || undefined,
			limit: input.limit,
			cursor: input.cursor,
		}),
	)
	return normalizePeople(upstream.body, 'people search')
}

/**
 * Fetch one person's profile by public handle or provider id. `me` returns the
 * connected account's own profile, which is how an agent answers "who am I
 * posting as".
 */
// ── Content-hash idempotency (Task 7b) ────────────────────────────────────
//
// Unipile v2's create-post / comment / reply-to-comment endpoints do NOT
// accept an Idempotency-Key header. Instead, the four destructive
// content/community tools dedup on
// `content_hash = sha256(canonical-json(request-body))`. Two identical calls
// collide on the `linkedin_tool_calls` primary key
// (actor_id, tool, content_hash): the first INSERT wins and hits Unipile;
// the second finds the row via ON CONFLICT DO NOTHING and replays the stored
// response verbatim, without a second Unipile call.
//
// Canonical-JSON via `fast-json-stable-stringify`: sorted keys, no
// whitespace, UTF-8. Semantically-identical bodies whose key order differs
// still produce the same hash. The docs are candid that
// semantically-identical `attachments` ordering could still miss the dedup
// key — the parent-bet notes accept that for v1 rather than gold-plating.

const LINKEDIN_TOOL_CALLS_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Canonical-JSON serializer: sorted keys, no whitespace, UTF-8. Two objects
 * with the same fields in a different order serialize to the same string,
 * so their sha256 content hashes collide and dedup fires. Arrays keep their
 * order — swapping `attachments[0]` and `attachments[1]` produces a different
 * hash by design (the parent-bet notes accept this v1 limitation over
 * gold-plating). No circular-reference handling — the caller shape is a
 * plain-object tool request, not an arbitrary graph.
 */
export function canonicalJson(value: unknown): string {
	if (value === null || value === undefined) return JSON.stringify(null)
	if (typeof value !== 'object') return JSON.stringify(value)
	if (Array.isArray(value)) {
		return `[${value.map((v) => canonicalJson(v)).join(',')}]`
	}
	const rec = value as Record<string, unknown>
	const keys = Object.keys(rec).sort()
	const parts: string[] = []
	for (const key of keys) {
		if (rec[key] === undefined) continue
		parts.push(`${JSON.stringify(key)}:${canonicalJson(rec[key])}`)
	}
	return `{${parts.join(',')}}`
}

export function computeContentHash(body: unknown): string {
	return createHash('sha256').update(canonicalJson(body)).digest('hex')
}

async function withContentHashIdempotency<T extends Record<string, unknown>>(opts: {
	db: Database
	actorId: string
	tool: string
	requestBody: unknown
	run: () => Promise<T>
}): Promise<T & { replayed: boolean }> {
	const contentHash = computeContentHash(opts.requestBody)
	// Only rows younger than the 24h TTL count as a live claim. An older row
	// exists — the nightly purge hasn't fired yet — but the caller's 24h retry
	// window has elapsed, so we deliberately let a second Unipile call happen.
	// Purge-then-retry ordering is inverted here vs the primary purge loop
	// because we can decide it at read time; the row will be swept by the
	// nightly job.
	const staleCutoff = new Date(Date.now() - LINKEDIN_TOOL_CALLS_TTL_MS)
	const [prior] = await opts.db
		.select()
		.from(linkedinToolCalls)
		.where(
			and(
				eq(linkedinToolCalls.actorId, opts.actorId),
				eq(linkedinToolCalls.tool, opts.tool),
				eq(linkedinToolCalls.contentHash, contentHash),
			),
		)
		.limit(1)

	if (prior && prior.createdAt >= staleCutoff) {
		return replayResponse<T>(prior.response)
	}

	const fresh = await opts.run()

	try {
		// If a prior row exists but is past the TTL, replace it so the freshly-
		// stored response wins on the next read. INSERT ... ON CONFLICT DO
		// UPDATE would collapse the read + write; the two-step read-then-write
		// costs a round-trip but keeps the "replayed" branch obviously distinct
		// from the "new call" branch — a reviewer can see which path ran.
		if (prior) {
			await opts.db
				.update(linkedinToolCalls)
				.set({ response: fresh, createdAt: new Date() })
				.where(
					and(
						eq(linkedinToolCalls.actorId, opts.actorId),
						eq(linkedinToolCalls.tool, opts.tool),
						eq(linkedinToolCalls.contentHash, contentHash),
					),
				)
		} else {
			await opts.db
				.insert(linkedinToolCalls)
				.values({
					actorId: opts.actorId,
					tool: opts.tool,
					contentHash,
					response: fresh,
				})
				.onConflictDoNothing()
		}
	} catch (err) {
		// The side effect already happened. Do NOT rethrow — that would hand the
		// caller a failure for work that succeeded and invite a retry that
		// re-publishes. The next duplicate simply won't dedup.
		logger.error('LinkedIn tool call succeeded but its dedup row was not persisted', {
			actorId: opts.actorId,
			tool: opts.tool,
			error: err instanceof Error ? err.message : String(err),
		})
	}
	return { ...(fresh as object), replayed: false } as T & { replayed: boolean }
}

// ── Content / community operations (Task 7b) ──────────────────────────────

export type PublishPostInput = {
	text?: unknown
	post_as?: unknown
	attachments?: unknown
	can_read?: unknown
	can_comment?: unknown
	quoted_post_id?: unknown
	specifics?: unknown
}

export type PublishPostResult = {
	post_id: string
	post_url?: string
	published_at: string
}

function normalizePublishResponse(body: unknown): PublishPostResult {
	const rec = (body ?? {}) as Record<string, unknown>
	const inner =
		rec.data && typeof rec.data === 'object' ? (rec.data as Record<string, unknown>) : rec
	const postId =
		typeof inner.post_id === 'string' ? inner.post_id : typeof inner.id === 'string' ? inner.id : ''
	const postUrl =
		typeof inner.post_url === 'string'
			? inner.post_url
			: typeof inner.share_url === 'string'
				? inner.share_url
				: undefined
	const publishedAt =
		typeof inner.published_at === 'string' ? inner.published_at : new Date().toISOString()
	if (!postId) {
		logger.error('linkedin-unipile publish: 2xx with no readable post id', {
			responseKeys: Object.keys(inner),
		})
	}
	return postUrl
		? { post_id: postId, post_url: postUrl, published_at: publishedAt }
		: { post_id: postId, published_at: publishedAt }
}

function validatePublishPostInput(
	input: PublishPostInput,
	opts: { requirePostAs: boolean },
):
	| { ok: true; payload: { text: string; post_as?: string; extras: Record<string, unknown> } }
	| {
			ok: false
			error: string
	  } {
	if (typeof input.text !== 'string' || input.text.length === 0) {
		return { ok: false, error: 'text is required' }
	}
	// LinkedIn's post-body limit is 3000 chars. We do NOT clamp here — the
	// LINKEDIN_POST_TOO_LONG classifier owns that outcome — but reject the
	// obvious oversized cases before spending a Unipile round-trip.
	if (input.text.length > 3000) {
		return { ok: false, error: 'text exceeds LinkedIn 3000-character limit' }
	}
	let postAs: string | undefined
	if (opts.requirePostAs) {
		if (typeof input.post_as !== 'string' || input.post_as.length === 0) {
			return { ok: false, error: 'page_id (post_as URN) is required for business-page publish' }
		}
		postAs = input.post_as
	} else if (typeof input.post_as === 'string' && input.post_as.length > 0) {
		postAs = input.post_as
	}
	const extras: Record<string, unknown> = {}
	if (Array.isArray(input.attachments)) extras.attachments = input.attachments
	if (typeof input.can_read === 'string') extras.can_read = input.can_read
	if (typeof input.can_comment === 'string') extras.can_comment = input.can_comment
	if (typeof input.quoted_post_id === 'string') extras.quoted_post_id = input.quoted_post_id
	if (input.specifics && typeof input.specifics === 'object') {
		extras.specifics = input.specifics as Record<string, unknown>
	}
	return {
		ok: true,
		payload: postAs ? { text: input.text, post_as: postAs, extras } : { text: input.text, extras },
	}
}

/**
 * Publish a LinkedIn post from the connected personal profile. Dedup'd via the
 * `linkedin_tool_calls` content-hash ledger: two identical requests within the
 * 24h TTL fire Unipile once and return identical responses.
 */
export async function publishLinkedInPost(
	ctx: LinkedInOperationContext,
	input: PublishPostInput,
): Promise<PublishPostResult & { replayed: boolean }> {
	const validation = validatePublishPostInput(input, { requirePostAs: false })
	if (!validation.ok) {
		throw new LinkedInIntegrationError('INVALID_INPUT', validation.error)
	}
	const pre = await preamble(ctx.db, ctx.actorId, ctx.workspaceId)
	if (!pre.ok) throw pre.error
	const client = buildUnipileClient(pre.credentials)
	// Hash the tool-facing request, not the Unipile wire body — an equivalent
	// request should collide even if Unipile renames a field later. `account_id`
	// is deliberately excluded because it identifies the caller's LinkedIn
	// credential, not the request semantics.
	const requestBody = { tool: 'linkedin_publish_post', ...validation.payload }
	return withContentHashIdempotency({
		db: ctx.db,
		actorId: ctx.actorId,
		tool: 'linkedin_publish_post',
		requestBody,
		run: async () => {
			const upstream = await callUnipileWithRetry<Record<string, unknown>>(
				() =>
					client.publishPost({
						account_id: pre.credentials.account_id,
						text: validation.payload.text,
						...(validation.payload.post_as ? { post_as: validation.payload.post_as } : {}),
						...validation.payload.extras,
					}),
				{ mutating: true },
			)
			return normalizePublishResponse(upstream.body)
		},
	})
}

/**
 * Thin wrapper over `publishLinkedInPost` that requires `post_as` (the page
 * URN). No separate Unipile credential — the same personal LinkedIn account
 * publishes as a page it admins, so this is a policy-level distinction in the
 * MCP surface, not a wholesale credential change (see the parent-bet spec's
 * business-page notes).
 */
export async function publishLinkedInBusinessPagePost(
	ctx: LinkedInOperationContext,
	input: PublishPostInput,
): Promise<PublishPostResult & { replayed: boolean }> {
	const validation = validatePublishPostInput(input, { requirePostAs: true })
	if (!validation.ok) {
		throw new LinkedInIntegrationError('INVALID_INPUT', validation.error)
	}
	const pre = await preamble(ctx.db, ctx.actorId, ctx.workspaceId)
	if (!pre.ok) throw pre.error
	const client = buildUnipileClient(pre.credentials)
	const requestBody = { tool: 'linkedin_publish_business_page_post', ...validation.payload }
	return withContentHashIdempotency({
		db: ctx.db,
		actorId: ctx.actorId,
		tool: 'linkedin_publish_business_page_post',
		requestBody,
		run: async () => {
			const upstream = await callUnipileWithRetry<Record<string, unknown>>(
				() =>
					client.publishPost({
						account_id: pre.credentials.account_id,
						text: validation.payload.text,
						post_as: validation.payload.post_as,
						...validation.payload.extras,
					}),
				{ mutating: true },
			)
			return normalizePublishResponse(upstream.body)
		},
	})
}

export type CommentInput = { post_id?: unknown; text?: unknown }
export type CommentResult = { comment_id: string; commented_at: string }

function normalizeCommentResponse(body: unknown): CommentResult {
	const rec = (body ?? {}) as Record<string, unknown>
	const inner =
		rec.data && typeof rec.data === 'object' ? (rec.data as Record<string, unknown>) : rec
	const commentId =
		typeof inner.comment_id === 'string'
			? inner.comment_id
			: typeof inner.id === 'string'
				? inner.id
				: ''
	const commentedAt =
		typeof inner.commented_at === 'string'
			? inner.commented_at
			: typeof inner.created_at === 'string'
				? inner.created_at
				: new Date().toISOString()
	if (!commentId) {
		logger.error('linkedin-unipile comment: 2xx with no readable comment id', {
			responseKeys: Object.keys(inner),
		})
	}
	return { comment_id: commentId, commented_at: commentedAt }
}

export async function commentOnLinkedInPost(
	ctx: LinkedInOperationContext,
	input: CommentInput,
): Promise<CommentResult & { replayed: boolean }> {
	const postId = typeof input.post_id === 'string' ? input.post_id.trim() : ''
	const text = typeof input.text === 'string' ? input.text : ''
	if (!postId) throw new LinkedInIntegrationError('INVALID_INPUT', 'post_id is required')
	if (!text.length) throw new LinkedInIntegrationError('INVALID_INPUT', 'text is required')
	if (text.length > 3000) {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			'text exceeds LinkedIn 3000-character limit',
		)
	}
	const pre = await preamble(ctx.db, ctx.actorId, ctx.workspaceId)
	if (!pre.ok) throw pre.error
	const client = buildUnipileClient(pre.credentials)
	const requestBody = { tool: 'linkedin_comment_on_post', post_id: postId, text }
	return withContentHashIdempotency({
		db: ctx.db,
		actorId: ctx.actorId,
		tool: 'linkedin_comment_on_post',
		requestBody,
		run: async () => {
			const upstream = await callUnipileWithRetry<Record<string, unknown>>(
				() =>
					client.commentOnPost({
						account_id: pre.credentials.account_id,
						post_id: postId,
						text,
					}),
				{ mutating: true },
			)
			return normalizeCommentResponse(upstream.body)
		},
	})
}

export type ReplyToCommentInput = { comment_id?: unknown; text?: unknown }

export async function replyToLinkedInComment(
	ctx: LinkedInOperationContext,
	input: ReplyToCommentInput,
): Promise<CommentResult & { replayed: boolean }> {
	const commentId = typeof input.comment_id === 'string' ? input.comment_id.trim() : ''
	const text = typeof input.text === 'string' ? input.text : ''
	if (!commentId) throw new LinkedInIntegrationError('INVALID_INPUT', 'comment_id is required')
	if (!text.length) throw new LinkedInIntegrationError('INVALID_INPUT', 'text is required')
	if (text.length > 3000) {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			'text exceeds LinkedIn 3000-character limit',
		)
	}
	const pre = await preamble(ctx.db, ctx.actorId, ctx.workspaceId)
	if (!pre.ok) throw pre.error
	const client = buildUnipileClient(pre.credentials)
	const requestBody = { tool: 'linkedin_reply_to_comment', comment_id: commentId, text }
	return withContentHashIdempotency({
		db: ctx.db,
		actorId: ctx.actorId,
		tool: 'linkedin_reply_to_comment',
		requestBody,
		run: async () => {
			const upstream = await callUnipileWithRetry<Record<string, unknown>>(
				() =>
					client.replyToComment({
						account_id: pre.credentials.account_id,
						comment_id: commentId,
						text,
					}),
				{ mutating: true },
			)
			return normalizeCommentResponse(upstream.body)
		},
	})
}

export type LinkedInComment = {
	comment_id: string
	author_urn: string
	author_name: string
	text: string
	created_at: string
}

const V2CommentSchema = z
	.object({
		id: z.string(),
		text: z.string().nullish(),
		created_at: z.string().optional(),
		author: z
			.object({ id: z.string().optional(), display_name: z.string().optional() })
			.passthrough()
			.optional(),
		author_id: z.string().optional(),
		author_name: z.string().optional(),
	})
	.passthrough()

function normalizeCommentsList(body: unknown): {
	comments: LinkedInComment[]
	next_cursor?: string
} {
	const { items, nextCursor } = readPage(body, 'post comments')
	const comments: LinkedInComment[] = []
	let skipped = 0
	for (const item of items) {
		const parsed = V2CommentSchema.safeParse(item)
		if (!parsed.success) {
			skipped++
			continue
		}
		const c = parsed.data
		comments.push({
			comment_id: c.id,
			author_urn: c.author?.id ?? c.author_id ?? '',
			author_name: c.author?.display_name ?? c.author_name ?? '',
			text: c.text ?? '',
			created_at: c.created_at ?? '',
		})
	}
	if (skipped > 0) {
		logger.warn('linkedin-unipile post comments: dropped unparseable rows', {
			skipped,
			total: items.length,
		})
	}
	return nextCursor ? { comments, next_cursor: nextCursor } : { comments }
}

/**
 * Read comments on a LinkedIn post, newest first, paged. Read-only, so no
 * content-hash dedup — the parent-bet spec §5 rule ("only mutating verbs
 * need dedup") applies here as it does to the messaging read tools.
 */
export async function readLinkedInPostComments(
	ctx: LinkedInOperationContext,
	input: { post_id?: unknown; limit?: number; cursor?: string },
): Promise<{ comments: LinkedInComment[]; next_cursor?: string }> {
	const postId = typeof input.post_id === 'string' ? input.post_id.trim() : ''
	if (!postId) throw new LinkedInIntegrationError('INVALID_INPUT', 'post_id is required')
	const pre = await preamble(ctx.db, ctx.actorId, ctx.workspaceId)
	if (!pre.ok) throw pre.error
	const client = buildUnipileClient(pre.credentials)
	const upstream = await callUnipileWithRetry<Record<string, unknown>>(() =>
		client.readPostComments({
			account_id: pre.credentials.account_id,
			post_id: postId,
			limit: input.limit,
			cursor: input.cursor,
		}),
	)
	return normalizeCommentsList(upstream.body)
}

export type PostEngagementResult = {
	post_id: string
	author_urn?: string
	published_at?: string
	text_preview?: string
	reactions: { total: number; sample: Array<{ user_urn: string; type: string }> }
	comments: { total: number }
	/**
	 * Per-sub-call error markers. `null` on a successful sub-call; the six-class
	 * code + message on failure. The whole tool call only fails if `retrievePost`
	 * fails (without base metadata there's nothing meaningful to return); a
	 * failed `listReactions` mid-cursor or a failed `countComments` leaves the
	 * partial envelope, with the marker set so the agent can see the degraded
	 * response.
	 */
	partial_errors: {
		reactions: { code: string; message: string } | null
		comments: { code: string; message: string } | null
	}
	/** True when `partial_errors` carries any non-null marker. */
	is_partial: boolean
}

function summarisePost(body: unknown): {
	author_urn?: string
	published_at?: string
	text_preview?: string
} {
	const rec = (body ?? {}) as Record<string, unknown>
	const inner =
		rec.data && typeof rec.data === 'object' ? (rec.data as Record<string, unknown>) : rec
	const author =
		inner.author && typeof inner.author === 'object'
			? (inner.author as Record<string, unknown>)
			: undefined
	const authorUrn =
		typeof inner.author_urn === 'string'
			? inner.author_urn
			: typeof author?.id === 'string'
				? (author.id as string)
				: undefined
	const publishedAt = typeof inner.published_at === 'string' ? inner.published_at : undefined
	const raw = typeof inner.text === 'string' ? inner.text : ''
	const textPreview = raw.length > 240 ? `${raw.slice(0, 240)}…` : raw || undefined
	return {
		...(authorUrn ? { author_urn: authorUrn } : {}),
		...(publishedAt ? { published_at: publishedAt } : {}),
		...(textPreview ? { text_preview: textPreview } : {}),
	}
}

async function collectReactions(
	client: UnipileClient,
	accountId: string,
	postId: string,
	sampleCap = 50,
	pageCap = 10,
): Promise<{ total: number; sample: Array<{ user_urn: string; type: string }> }> {
	const sample: Array<{ user_urn: string; type: string }> = []
	let total = 0
	let cursor: string | undefined
	for (let page = 0; page < pageCap; page++) {
		const upstream = await callUnipileWithRetry<Record<string, unknown>>(() =>
			client.listReactions({ account_id: accountId, post_id: postId, cursor, limit: 50 }),
		)
		const body = (upstream.body ?? {}) as Record<string, unknown>
		if (!Array.isArray(body.data)) {
			logger.error('linkedin-unipile reactions: no data array in response', {
				responseKeys: Object.keys(body),
			})
			throw new LinkedInIntegrationError(
				'UNIPILE_UNAVAILABLE',
				'Unipile reactions response had an unrecognised shape',
			)
		}
		for (const item of body.data as unknown[]) {
			total++
			if (sample.length < sampleCap && item && typeof item === 'object') {
				const rec = item as Record<string, unknown>
				const user = rec.user as Record<string, unknown> | undefined
				const userUrn =
					typeof rec.user_id === 'string'
						? rec.user_id
						: typeof user?.id === 'string'
							? (user.id as string)
							: ''
				const reactionType =
					typeof rec.reaction_type === 'string'
						? rec.reaction_type
						: typeof rec.type === 'string'
							? rec.type
							: 'LIKE'
				if (userUrn) sample.push({ user_urn: userUrn, type: reactionType })
			}
		}
		const next = typeof body.next_cursor === 'string' ? body.next_cursor : undefined
		if (!next) return { total, sample }
		cursor = next
	}
	// Hit the page cap. Log so a viral-post enumeration surfaces in dashboards
	// but return what we have — this is not an error condition.
	logger.warn('linkedin-unipile reactions: hit page cap, returning partial totals', {
		postId,
		pageCap,
		countedSoFar: total,
	})
	return { total, sample }
}

async function safeCollectReactions(
	client: UnipileClient,
	accountId: string,
	postId: string,
): Promise<{
	value: { total: number; sample: Array<{ user_urn: string; type: string }> }
	error: { code: string; message: string } | null
}> {
	try {
		return { value: await collectReactions(client, accountId, postId), error: null }
	} catch (err) {
		if (err instanceof LinkedInIntegrationError) {
			return {
				value: { total: 0, sample: [] },
				error: { code: err.code, message: err.message },
			}
		}
		return {
			value: { total: 0, sample: [] },
			error: { code: 'UNIPILE_UNAVAILABLE', message: 'Unexpected error collecting reactions' },
		}
	}
}

async function safeCountComments(
	client: UnipileClient,
	accountId: string,
	postId: string,
): Promise<{ value: { total: number }; error: { code: string; message: string } | null }> {
	try {
		const upstream = await callUnipileWithRetry<Record<string, unknown>>(() =>
			client.countComments({ account_id: accountId, post_id: postId }),
		)
		const body = (upstream.body ?? {}) as Record<string, unknown>
		const paging = body.paging as Record<string, unknown> | undefined
		const total =
			typeof paging?.total_count === 'number'
				? paging.total_count
				: typeof body.total === 'number'
					? body.total
					: Array.isArray(body.data)
						? (body.data as unknown[]).length
						: 0
		return { value: { total }, error: null }
	} catch (err) {
		if (err instanceof LinkedInIntegrationError) {
			return { value: { total: 0 }, error: { code: err.code, message: err.message } }
		}
		return {
			value: { total: 0 },
			error: { code: 'UNIPILE_UNAVAILABLE', message: 'Unexpected error counting comments' },
		}
	}
}

/**
 * Fan-out engagement read: `retrievePost` + `listReactions` (paginated) +
 * `countComments`. Each sub-call is handled independently — a paginated
 * `listReactions` failing mid-cursor returns a partial envelope with
 * `partial_errors.reactions` set and `is_partial: true`, rather than
 * collapsing the whole tool call. `retrievePost` failing IS terminal: the base
 * metadata is what the caller was asking for, so returning a synthetic empty
 * envelope would be worse than an honest failure. Read-only, so no
 * content-hash dedup — see the read-tools rule in the parent-bet spec §5.
 *
 * Impressions are NOT in the envelope. Unipile v2 does not expose them for
 * third-party posts. If Sebk's open A reverses, follow-on task.
 */
export async function getLinkedInPostEngagement(
	ctx: LinkedInOperationContext,
	input: { post_id?: unknown },
): Promise<PostEngagementResult> {
	const postId = typeof input.post_id === 'string' ? input.post_id.trim() : ''
	if (!postId) throw new LinkedInIntegrationError('INVALID_INPUT', 'post_id is required')
	const pre = await preamble(ctx.db, ctx.actorId, ctx.workspaceId)
	if (!pre.ok) throw pre.error
	const client = buildUnipileClient(pre.credentials)
	const acc = pre.credentials.account_id
	// retrievePost first — if the base post read fails, there's nothing to
	// return but an empty envelope, so treat that as terminal.
	const postResp = await callUnipileWithRetry<Record<string, unknown>>(() =>
		client.retrievePost({ account_id: acc, post_id: postId }),
	)
	const summary = summarisePost(postResp.body)
	// Reactions + comments run concurrently — each is independent, and both
	// failing degrades to a base-metadata-only envelope rather than a total
	// failure. `Promise.all` is fine because both `safeCollectReactions` and
	// `safeCountComments` swallow their own errors.
	const [reactions, comments] = await Promise.all([
		safeCollectReactions(client, acc, postId),
		safeCountComments(client, acc, postId),
	])
	const isPartial = reactions.error !== null || comments.error !== null
	return {
		post_id: postId,
		...summary,
		reactions: reactions.value,
		comments: comments.value,
		partial_errors: { reactions: reactions.error, comments: comments.error },
		is_partial: isPartial,
	}
}

export async function getLinkedInProfile(
	ctx: LinkedInOperationContext,
	input: { identifier?: unknown },
): Promise<LinkedInPerson> {
	const identifier = typeof input.identifier === 'string' ? input.identifier.trim() : ''
	if (!identifier) {
		throw new LinkedInIntegrationError('INVALID_INPUT', 'identifier is required')
	}
	const pre = await preamble(ctx.db, ctx.actorId, ctx.workspaceId)
	if (!pre.ok) throw pre.error
	const client = buildUnipileClient(pre.credentials)
	const upstream = await callUnipileWithRetry<Record<string, unknown>>(() =>
		client.getProfile({ account_id: pre.credentials.account_id, identifier }),
	)
	const person = toPerson(upstream.body)
	if (!person) {
		throw new LinkedInIntegrationError(
			'UNIPILE_UNAVAILABLE',
			'Unipile profile response had an unrecognised shape',
		)
	}
	return person
}

/**
 * Send a LinkedIn connection-request (invitation) from the connected account
 * to a target member.
 *
 * NOT idempotency-tracked (spec residual on Task 7a). LinkedIn/Unipile give
 * the wire-level guarantee via `LINKEDIN_ALREADY_CONNECTED` — a duplicate
 * invite is rejected with that error class on the second call — so an
 * `idempotency_records` claim would only duplicate a check LinkedIn already
 * enforces server-side.
 *
 * `mutating: true` on the retry policy still holds: a 5xx that arrives
 * between LinkedIn accepting the invite and Unipile answering us must NOT be
 * transparently replayed. A replay would either (a) burn a second invite
 * quota against the same target with no user-visible effect, or (b) return
 * `LINKEDIN_ALREADY_CONNECTED` and confuse the caller into thinking the
 * connection existed before the first attempt.
 */
export async function sendLinkedInConnectionRequest(
	ctx: LinkedInOperationContext,
	input: { user_id?: unknown; message?: unknown },
): Promise<{ status: 'sent'; sent_at: string; invitation_id?: string }> {
	const userId = typeof input.user_id === 'string' ? input.user_id.trim() : ''
	if (!userId) {
		throw new LinkedInIntegrationError('INVALID_INPUT', 'user_id is required')
	}
	// `message` is deliberately unconstrained at the client — LinkedIn
	// enforces the 200-char invite-note cap on the wire (per Sebk's platform
	// sign-off 2026-09-07), and a client-side pre-check would drift from
	// LinkedIn's real behaviour the moment they change it. An empty string
	// after trim collapses to "no note" so the wire receives a bare invite
	// rather than an empty-string one.
	const rawMessage = typeof input.message === 'string' ? input.message : ''
	const message = rawMessage.trim().length > 0 ? rawMessage : undefined
	const pre = await preamble(ctx.db, ctx.actorId, ctx.workspaceId)
	if (!pre.ok) throw pre.error
	const client = buildUnipileClient(pre.credentials)
	const upstream = await callUnipileWithRetry<
		UnipileConnectionRequestResponse | Record<string, unknown>
	>(
		() =>
			client.sendConnectionRequest({
				account_id: pre.credentials.account_id,
				user_id: userId,
				...(message !== undefined ? { message } : {}),
			}),
		{ mutating: true },
	)
	return normalizeConnectionRequestResponse(upstream.body)
}

function normalizeConnectionRequestResponse(
	body: UnipileConnectionRequestResponse | Record<string, unknown>,
): { status: 'sent'; sent_at: string; invitation_id?: string } {
	const rec = (body ?? {}) as Record<string, unknown>
	const inner =
		rec.data && typeof rec.data === 'object' ? (rec.data as Record<string, unknown>) : rec
	const invitationId =
		typeof inner.invitation_id === 'string'
			? inner.invitation_id
			: typeof inner.id === 'string'
				? inner.id
				: undefined
	const sentAt = typeof inner.sent_at === 'string' ? inner.sent_at : new Date().toISOString()
	return {
		status: 'sent',
		sent_at: sentAt,
		...(invitationId ? { invitation_id: invitationId } : {}),
	}
}
