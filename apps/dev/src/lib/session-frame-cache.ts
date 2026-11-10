import type { Database } from '@maskin/db'
import { conversationParticipants } from '@maskin/db/schema'
import { and, eq, isNull } from 'drizzle-orm'

/**
 * In-process TTL cache with a size bound. When full, the oldest entry (insertion order) is dropped.
 * Only for lookups whose answer does not depend on who is asking.
 */
export class TtlCache<K, V> {
	private readonly entries = new Map<K, { value: V; expiresAt: number }>()

	constructor(
		private readonly maxEntries: number,
		private readonly ttlMs: number,
		private readonly now: () => number = Date.now,
	) {}

	get(key: K): V | undefined {
		const hit = this.entries.get(key)
		if (!hit) return undefined
		if (hit.expiresAt <= this.now()) {
			this.entries.delete(key)
			return undefined
		}
		return hit.value
	}

	set(key: K, value: V): void {
		this.entries.delete(key)
		while (this.entries.size >= this.maxEntries) {
			const oldest = this.entries.keys().next()
			if (oldest.done) break
			this.entries.delete(oldest.value)
		}
		this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs })
	}

	clear(): void {
		this.entries.clear()
	}
}

/** Which conversation (and workspace) a sub-session belongs to. Fixed once the session exists. */
export type SessionAnchor = {
	workspaceId: string
	spawnedByMessageId: number | null
	conversationId: string | null
}

export const SESSION_ANCHOR_TTL_MS = 30_000
export const PARTICIPANTS_TTL_MS = 5_000

export const sessionAnchorCache = new TtlCache<string, SessionAnchor>(5000, SESSION_ANCHOR_TTL_MS)
const participantsCache = new TtlCache<string, Set<string>>(5000, PARTICIPANTS_TTL_MS)

/**
 * Whether `actorId` is an active participant of the conversation. The participant set is shared
 * per conversation for a few seconds; the answer is still decided per actor on every call, so a
 * cached set for one connection never grants another actor anything.
 */
export async function isCachedConversationParticipant(
	db: Database,
	conversationId: string,
	actorId: string,
): Promise<boolean> {
	let set = participantsCache.get(conversationId)
	if (!set) {
		const rows = await db
			.select({ actorId: conversationParticipants.actorId })
			.from(conversationParticipants)
			.where(
				and(
					eq(conversationParticipants.conversationId, conversationId),
					isNull(conversationParticipants.leftAt),
				),
			)
		set = new Set(rows.map((r) => r.actorId))
		participantsCache.set(conversationId, set)
	}
	return set.has(actorId)
}

export function clearSessionFrameCaches(): void {
	sessionAnchorCache.clear()
	participantsCache.clear()
}
