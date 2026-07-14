import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq, notInArray } from 'drizzle-orm'

export interface KnowledgeDuplicate {
	id: string
	title: string | null
}

const MIN_CONTAINMENT_LENGTH = 8

// Statuses that mark a knowledge object as no longer "live" — superseding one
// (extensions/knowledge/shared.ts's KNOWLEDGE_RELATIONSHIP_TYPES includes
// 'supersedes') or archiving it must stay possible without tripping the
// duplicate check on the object it replaces.
const RETIRED_KNOWLEDGE_STATUSES = ['archived', 'deprecated']

// Name of the partial unique index defined in
// packages/db/drizzle/0047_knowledge_partial_unique_title_idx.sql — the DB-side
// backstop for the check-then-insert TOCTOU race in POST /api/objects and
// POST /api/graph. Kept as a single string so the route handlers and the
// migration stay in lockstep.
export const KNOWLEDGE_TITLE_UNIQUE_CONSTRAINT = 'objects_ws_knowledge_title_unique_idx'

/**
 * True if `err` (or any error in its `.cause` chain) is a Postgres
 * `unique_violation` (SQLSTATE 23505) raised by the knowledge-title partial
 * unique index. Drizzle wraps the driver's PostgresError as `err.cause`, so we
 * walk the chain — same pattern as `isUniqueViolation` in workspace-skills.ts.
 */
export function isKnowledgeTitleUniqueViolation(err: unknown): boolean {
	for (let current: unknown = err; current && typeof current === 'object'; ) {
		const e = current as {
			code?: string
			constraint_name?: string
			constraint?: string
			message?: string
			cause?: unknown
		}
		if (e.code === '23505') {
			const name = e.constraint_name ?? e.constraint
			if (name === KNOWLEDGE_TITLE_UNIQUE_CONSTRAINT) return true
			if (typeof e.message === 'string' && e.message.includes(KNOWLEDGE_TITLE_UNIQUE_CONSTRAINT))
				return true
		}
		current = e.cause
	}
	return false
}

export function normalizeTitle(title: string): string {
	return title.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * True if two already-normalized titles are the same or one contains the
 * other. Containment only counts once both sides clear
 * MIN_CONTAINMENT_LENGTH, so generic short titles ("Setup") don't
 * false-positive against every longer title that happens to include them.
 */
export function isDuplicateTitle(a: string, b: string): boolean {
	if (!a || !b) return false
	if (a === b) return true
	const shorterLength = Math.min(a.length, b.length)
	return shorterLength >= MIN_CONTAINMENT_LENGTH && (a.includes(b) || b.includes(a))
}

/**
 * Finds an existing, live (not archived/deprecated) `knowledge` object in the
 * workspace whose title exactly matches or contains/is-contained-by the given
 * title (case/whitespace-insensitive).
 */
export async function findKnowledgeDuplicate(
	db: Database,
	workspaceId: string,
	title: string | undefined,
): Promise<KnowledgeDuplicate | null> {
	if (!title) return null
	const normalized = normalizeTitle(title)
	if (!normalized) return null

	const candidates = await db
		.select({ id: objects.id, title: objects.title })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'knowledge'),
				notInArray(objects.status, RETIRED_KNOWLEDGE_STATUSES),
			),
		)

	for (const candidate of candidates) {
		if (!candidate.title) continue
		const candidateNormalized = normalizeTitle(candidate.title)
		if (isDuplicateTitle(candidateNormalized, normalized)) return candidate
	}

	return null
}
