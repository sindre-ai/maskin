import type { Database, Transaction } from '@maskin/db'
import { type ApiKeyKind, actors, apiKeys } from '@maskin/db/schema'
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { evictApiKeyHash } from './auth-cache'
import { hashApiKey } from './key-hash'

type Executor = Database | Transaction

/** Live login keys kept per actor and per login kind; a newer login revokes the oldest. */
export const LOGIN_KEY_CAP = 10

export function generateApiKey(): { key: string } {
	const key = `ank_${crypto.randomUUID().replace(/-/g, '')}`
	return { key }
}

/**
 * Resolves a bearer token to its actor. A hit stamps last_used_at on the key row. Callers sit
 * behind the auth cache, so that is at most one write per key per cache window per process.
 * The stamp is best effort: a failed write never fails the request.
 */
export async function validateApiKey(
	db: Executor,
	apiKey: string,
): Promise<{ actorId: string; type: string } | null> {
	const [actor] = await db
		.select({ id: actors.id, type: actors.type, keyId: apiKeys.id })
		.from(apiKeys)
		.innerJoin(actors, eq(actors.id, apiKeys.actorId))
		.where(
			and(
				eq(apiKeys.keyHash, hashApiKey(apiKey)),
				isNull(apiKeys.revokedAt),
				or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, sql`now()`)),
			),
		)
		.limit(1)

	if (!actor) return null

	try {
		await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, actor.keyId))
	} catch {
		// Usage tracking only informs which old agent keys are still in use; never block a request on it.
	}
	return { actorId: actor.id, type: actor.type }
}

/**
 * Mints a key for an actor and stores only its hash. The returned plaintext is the one and
 * only copy: hand it to the caller or inject it, never persist it.
 */
export async function issueApiKey(
	db: Executor,
	input: { actorId: string; kind: ApiKeyKind; sessionId?: string; expiresAt?: Date },
): Promise<{ key: string; keyHash: string }> {
	const { key } = generateApiKey()
	const keyHash = hashApiKey(key)
	await db.insert(apiKeys).values({
		actorId: input.actorId,
		keyHash,
		last4: key.slice(-4),
		kind: input.kind,
		sessionId: input.sessionId ?? null,
		expiresAt: input.expiresAt ?? null,
	})
	return { key, keyHash }
}

/**
 * Revokes every live key matching the filter and drops each from the auth cache, so the key
 * stops working on the next request rather than when its cached lookup expires. Inside a
 * transaction, callers should also evict after commit (a request in between can re-cache).
 */
async function revokeWhere(db: Executor, filter: ReturnType<typeof and>): Promise<string[]> {
	const revoked = await db
		.update(apiKeys)
		.set({ revokedAt: new Date() })
		.where(and(isNull(apiKeys.revokedAt), filter))
		.returning({ keyHash: apiKeys.keyHash })
	const hashes = revoked.map((r) => r.keyHash)
	for (const hash of hashes) evictApiKeyHash(hash)
	return hashes
}

/** Revokes an actor's live keys, optionally only some kinds. */
export function revokeActorKeys(
	db: Executor,
	actorId: string,
	kinds?: readonly ApiKeyKind[],
): Promise<string[]> {
	return revokeWhere(
		db,
		and(
			eq(apiKeys.actorId, actorId),
			kinds && kinds.length > 0 ? inArray(apiKeys.kind, [...kinds]) : undefined,
		),
	)
}

/** Revokes the live keys of one session, except the one named (the key just minted for it). */
export function revokeSessionKeys(
	db: Executor,
	sessionId: string,
	exceptKeyHash?: string,
): Promise<string[]> {
	return revokeWhere(
		db,
		and(
			eq(apiKeys.sessionId, sessionId),
			exceptKeyHash ? ne(apiKeys.keyHash, exceptKeyHash) : undefined,
		),
	)
}

/**
 * Mints a login key and keeps at most LOGIN_KEY_CAP live ones of that kind for the actor,
 * revoking the oldest. iOS uses its own kind, so web logins can never push a phone out.
 */
export async function issueLoginKey(
	db: Executor,
	actorId: string,
	kind: Extract<ApiKeyKind, 'login' | 'login_ios'>,
): Promise<string> {
	const { key } = await issueApiKey(db, { actorId, kind })
	const overflow = await db
		.select({ id: apiKeys.id, keyHash: apiKeys.keyHash })
		.from(apiKeys)
		.where(and(eq(apiKeys.actorId, actorId), eq(apiKeys.kind, kind), isNull(apiKeys.revokedAt)))
		.orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
		.offset(LOGIN_KEY_CAP)
	if (overflow.length > 0) {
		await db
			.update(apiKeys)
			.set({ revokedAt: new Date() })
			.where(
				inArray(
					apiKeys.id,
					overflow.map((o) => o.id),
				),
			)
		for (const o of overflow) evictApiKeyHash(o.keyHash)
	}
	return key
}
