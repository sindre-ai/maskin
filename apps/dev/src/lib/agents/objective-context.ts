import type { Database } from '@maskin/db'
import { events, actors, objects, relationships } from '@maskin/db/schema'
import { and, desc, eq, inArray } from 'drizzle-orm'

/**
 * Compose a compact "Shared Objective" block the agent can read at the top of
 * its prompt. Includes the object's title, the parent bet (traversed via
 * `breaks_into` edges), current assignees + watchers, and the last few
 * comments so the agent picks up mid-thread context.
 *
 * Returns null when the object is missing — callers should no-op in that case.
 */
export async function buildObjectiveContext(
	db: Database,
	objectId: string,
): Promise<string | null> {
	const [object] = await db.select().from(objects).where(eq(objects.id, objectId)).limit(1)
	if (!object) return null

	// Parent bet: object is a target of a `breaks_into` edge from a bet.
	const parentEdge = await db
		.select({ sourceId: relationships.sourceId })
		.from(relationships)
		.where(and(eq(relationships.targetId, objectId), eq(relationships.type, 'breaks_into')))
		.limit(1)

	let parent: typeof objects.$inferSelect | null = null
	if (parentEdge[0]) {
		const [row] = await db
			.select()
			.from(objects)
			.where(eq(objects.id, parentEdge[0].sourceId))
			.limit(1)
		parent = row ?? null
	}

	// Participants: assignees + watchers (object → actor edges).
	const participantEdges = await db
		.select({ targetId: relationships.targetId, type: relationships.type })
		.from(relationships)
		.where(
			and(
				eq(relationships.sourceType, 'object'),
				eq(relationships.targetType, 'actor'),
				eq(relationships.sourceId, objectId),
				inArray(relationships.type, ['assigned_to', 'watches']),
			),
		)

	const actorIds = [...new Set(participantEdges.map((e) => e.targetId))]
	const participantActors = actorIds.length
		? await db
				.select({ id: actors.id, name: actors.name, type: actors.type })
				.from(actors)
				.where(inArray(actors.id, actorIds))
		: []
	const nameById = new Map(participantActors.map((a) => [a.id, { name: a.name, type: a.type }]))

	const assignees = participantEdges
		.filter((e) => e.type === 'assigned_to')
		.map((e) => nameById.get(e.targetId))
		.filter((a): a is { name: string; type: string } => !!a)
	const watchers = participantEdges
		.filter((e) => e.type === 'watches')
		.map((e) => nameById.get(e.targetId))
		.filter((a): a is { name: string; type: string } => !!a)

	// Last 5 comments on this object (most recent first, then reversed for reading order).
	const recentComments = await db
		.select()
		.from(events)
		.where(and(eq(events.entityId, objectId), eq(events.action, 'commented')))
		.orderBy(desc(events.createdAt))
		.limit(5)

	const commentLines: string[] = []
	if (recentComments.length > 0) {
		const commentActorIds = [...new Set(recentComments.map((c) => c.actorId))]
		const commentActors = await db
			.select({ id: actors.id, name: actors.name })
			.from(actors)
			.where(inArray(actors.id, commentActorIds))
		const commentNameById = new Map(commentActors.map((a) => [a.id, a.name]))
		for (const c of [...recentComments].reverse()) {
			const name = commentNameById.get(c.actorId) ?? 'Unknown'
			const text = ((c.data as { content?: string } | null)?.content ?? '').trim()
			if (!text) continue
			const oneLine = text.length > 200 ? `${text.slice(0, 197)}…` : text
			commentLines.push(`- ${name}: ${oneLine.replace(/\n+/g, ' ')}`)
		}
	}

	const lines: string[] = ['## Shared Objective']
	lines.push(`Title: ${object.title ?? '(untitled)'}`)
	lines.push(`Type: ${object.type}`)
	lines.push(`Status: ${object.status}`)
	if (parent) lines.push(`Parent bet: ${parent.title ?? '(untitled)'}`)
	if (assignees.length > 0) {
		lines.push(`Assignees: ${assignees.map((a) => `${a.name} (${a.type})`).join(', ')}`)
	}
	if (watchers.length > 0) {
		lines.push(`Watchers: ${watchers.map((a) => a.name).join(', ')}`)
	}
	if (commentLines.length > 0) {
		lines.push('')
		lines.push('Recent comments:')
		lines.push(...commentLines)
	}
	return lines.join('\n')
}
