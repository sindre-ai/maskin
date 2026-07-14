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
