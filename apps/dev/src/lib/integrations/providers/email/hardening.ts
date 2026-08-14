import type { Database } from '@maskin/db'
import { agentEmailSends } from '@maskin/db/schema'
import { and, eq, gte, isNotNull, sql } from 'drizzle-orm'

// Defaults + hard bounds for the per-agent rolling-hour rate limit.
//
// The ceiling is small on purpose — agent-initiated email is a spam vector
// that survives every other gate (workspace-member allowlist, image
// stripping) if abused at volume. Ten sends per hour is enough for a
// legitimate assistant flow and low enough that a runaway agent surfaces
// as `rate_limit_exceeded` before it can deliver material harm.
const DEFAULT_LIMIT_PER_HOUR = 10
const WINDOW_MS = 60 * 60 * 1000

// A number well above any plausible legitimate ceiling — set to catch
// misconfiguration (accidentally huge `AGENT_EMAIL_RATE_LIMIT_PER_HOUR`
// via a stray typo) rather than to enforce policy. The rate-limit stays
// self-defending even without an operator-set value; this cap only guards
// against a caller trying to disable it by setting a giant value.
const MAX_LIMIT_PER_HOUR = 10_000

// Reads `AGENT_EMAIL_RATE_LIMIT_PER_HOUR` from the environment and coerces
// it to a bounded positive integer. Anything invalid — non-numeric, ≤ 0,
// NaN, or over the sanity ceiling — falls back to the default rather than
// silently dropping the guard. Follows the safe-numeric-parsing rule in
// `.claude/rules/input-validation.md`.
export function readAgentEmailRateLimitPerHour(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.AGENT_EMAIL_RATE_LIMIT_PER_HOUR
	if (raw === undefined || raw === '') return DEFAULT_LIMIT_PER_HOUR
	const parsed = Number(raw)
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT_PER_HOUR
	const floored = Math.floor(parsed)
	if (floored > MAX_LIMIT_PER_HOUR) return DEFAULT_LIMIT_PER_HOUR
	return floored
}

export interface RateLimitAllowed {
	ok: true
	limit: number
	used: number
}

export interface RateLimitBlocked {
	ok: false
	error: 'rate_limit_exceeded'
	limit: number
	used: number
	retryAfterSeconds: number
}

export type RateLimitResult = RateLimitAllowed | RateLimitBlocked

// Checks the rolling-hour count of successful sends for `actorId`. Fires
// **before** the workspace-member allowlist so probing invalid recipients
// still counts against the ceiling — otherwise an attacker could spam
// unlimited requests at strangers as long as none of them ever get through.
//
// Fail-closed on DB error: a rate-check that can't count treats the send as
// blocked. The brief calls this out explicitly: "rate-check errors count as
// a block." A soft-fail here would give a caller unlimited sends the
// instant the ledger table is unreachable.
export async function checkAgentEmailRateLimit(
	db: Database,
	actorId: string,
	options: { now?: Date; limitPerHour?: number } = {},
): Promise<RateLimitResult> {
	const limit = options.limitPerHour ?? readAgentEmailRateLimitPerHour()
	const now = options.now ?? new Date()
	const windowStart = new Date(now.getTime() - WINDOW_MS)

	let used = 0
	let oldestInWindow: Date | null = null
	try {
		const [row] = await db
			.select({
				count: sql<number>`count(*)::int`,
				oldest: sql<Date | null>`min(${agentEmailSends.sentAt})`,
			})
			.from(agentEmailSends)
			.where(and(eq(agentEmailSends.actorId, actorId), gte(agentEmailSends.sentAt, windowStart)))
		used = Number(row?.count ?? 0)
		oldestInWindow = row?.oldest ? new Date(row.oldest) : null
	} catch {
		return {
			ok: false,
			error: 'rate_limit_exceeded',
			limit,
			used: limit,
			retryAfterSeconds: 60,
		}
	}

	if (used < limit) return { ok: true, limit, used }

	// When the ceiling has been hit, the earliest safe next-send is when
	// the oldest in-window row falls out of the sliding window. If we can't
	// see one for some reason, fall back to a full window so the caller
	// gets a value rather than 0.
	const nextFreeAtMs = oldestInWindow
		? oldestInWindow.getTime() + WINDOW_MS
		: now.getTime() + WINDOW_MS
	const retryAfterSeconds = Math.max(1, Math.ceil((nextFreeAtMs - now.getTime()) / 1000))
	return { ok: false, error: 'rate_limit_exceeded', limit, used, retryAfterSeconds }
}

// Returns the provider message id of a prior send that used
// `(workspaceId, actorId, idempotencyKey)`, or null if none exists.
// The partial unique index on `agent_email_sends` guarantees at most one
// row per triple.
export async function findExistingAgentEmailSend(
	db: Database,
	workspaceId: string,
	actorId: string,
	idempotencyKey: string,
): Promise<{ providerMessageId: string } | null> {
	const [row] = await db
		.select({ providerMessageId: agentEmailSends.providerMessageId })
		.from(agentEmailSends)
		.where(
			and(
				eq(agentEmailSends.workspaceId, workspaceId),
				eq(agentEmailSends.actorId, actorId),
				isNotNull(agentEmailSends.idempotencyKey),
				eq(agentEmailSends.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1)
	return row ?? null
}

export interface RecordAgentEmailSendInput {
	workspaceId: string
	actorId: string
	idempotencyKey: string | null
	providerMessageId: string
}

// Persists a successful send. Called only after Resend returns a message id.
// A `23505` unique-violation here means a concurrent send with the same
// idempotency key raced ahead — the caller should treat that identically to
// a pre-send `findExistingAgentEmailSend` hit and surface `already_sent`.
export async function recordAgentEmailSend(
	db: Database,
	input: RecordAgentEmailSendInput,
): Promise<void> {
	await db.insert(agentEmailSends).values({
		workspaceId: input.workspaceId,
		actorId: input.actorId,
		idempotencyKey: input.idempotencyKey,
		providerMessageId: input.providerMessageId,
	})
}

// Narrow guard for the Postgres unique-violation code so `mcp-server.ts`
// can react to the concurrent-idempotency-key race without pulling in the
// full `postgres` type surface.
export function isUniqueViolation(err: unknown): boolean {
	if (typeof err !== 'object' || err === null) return false
	const code = (err as { code?: unknown }).code
	return code === '23505'
}
