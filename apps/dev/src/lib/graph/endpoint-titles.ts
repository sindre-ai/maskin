import type { Database, Transaction } from '@maskin/db'
import { conversations, objects, sessions } from '@maskin/db/schema'
import { inArray } from 'drizzle-orm'

// Batch-resolvable graph endpoint kinds. `file` is deliberately excluded —
// Task 1 owns file title hydration through its own helper (colocated with the
// files-endpoint code path) and treating files here would duplicate the batch
// lookup at two sites. Anything not in this list resolves through the
// existing `objects.title` path.
export type EndpointKind = 'object' | 'conversation' | 'session'

/**
 * Resolves a batch of graph endpoint ids to their display titles for the
 * relationships / graph / traverse read paths. Runs one SELECT per endpoint
 * kind (object, conversation, session) and returns a merged `Map<id, title>`.
 *
 * Titles follow the source-of-truth per kind:
 *  - `object` — `objects.title`
 *  - `conversation` — `conversations.title` (always non-null in schema)
 *  - `session` — `sessions.actionPrompt` truncated to a headline, with a
 *    hard fallback to a short id-suffix chip when `actionPrompt` is null (a
 *    shape sessions can hit only for the internal "resume from snapshot"
 *    path today; kept as a defensive branch)
 *
 * File hydration is handled separately by Task 1's helper — this function is
 * additive to that path, not a replacement.
 */
export async function resolveEndpointTitles(
	dbOrTx: Database | Transaction,
	ids: {
		objectIds?: readonly string[]
		conversationIds?: readonly string[]
		sessionIds?: readonly string[]
	},
): Promise<Map<string, string | null>> {
	const out = new Map<string, string | null>()

	if (ids.objectIds && ids.objectIds.length > 0) {
		const rows = await dbOrTx
			.select({ id: objects.id, title: objects.title })
			.from(objects)
			.where(inArray(objects.id, [...ids.objectIds]))
		for (const row of rows) out.set(row.id, row.title ?? null)
	}

	if (ids.conversationIds && ids.conversationIds.length > 0) {
		const rows = await dbOrTx
			.select({ id: conversations.id, title: conversations.title })
			.from(conversations)
			.where(inArray(conversations.id, [...ids.conversationIds]))
		for (const row of rows) out.set(row.id, row.title ?? null)
	}

	if (ids.sessionIds && ids.sessionIds.length > 0) {
		const rows = await dbOrTx
			.select({ id: sessions.id, actionPrompt: sessions.actionPrompt })
			.from(sessions)
			.where(inArray(sessions.id, [...ids.sessionIds]))
		for (const row of rows) out.set(row.id, sessionTitleFrom(row.actionPrompt, row.id))
	}

	return out
}

/**
 * Distill a `sessions.actionPrompt` into the compact headline the graph
 * endpoints use as a session's title. First non-empty line, hard-truncated
 * to keep the row visually consistent with the other kinds' titles.
 *
 * Not exported by default — the resolve helper is the public entrypoint —
 * but exported so tests can pin the truncation contract without going
 * through the DB.
 */
export function sessionTitleFrom(actionPrompt: string | null, sessionId: string): string {
	const MAX = 80
	const raw = (actionPrompt ?? '')
		.split('\n')
		.find((line) => line.trim().length > 0)
		?.trim()
	if (!raw) return `Session ${sessionId.slice(0, 8)}`
	if (raw.length <= MAX) return raw
	return `${raw.slice(0, MAX - 1).trimEnd()}…`
}
