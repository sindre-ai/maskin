import type { Database, Transaction } from '@maskin/db'
import { events, objects } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

// The relationship-create and graph.ts paths both call the auto-emit hook —
// graph.ts runs inside a tx so the emit's `events` row must land in the same
// tx. Widen the DB type here so both callers work without hopping out of
// their tx.
type DbHandle = Database | Transaction

// Canonical spelling of the Knowledge close loop bet's ship-metric action.
// The `events.action` column is unconstrained text (packages/db/src/schema.ts
// line 146), so the pipeline accepts any string — this constant exists so
// downstream readers (SSE consumers, the T6 "Referenced by N sessions/week"
// chip, and the PostHog ship-metric query) can't drift out of sync.
export const WORKSPACE_KNOWLEDGE_REFERENCED = 'workspace_knowledge_referenced'

// Canonical event names for the Knowledge Extension retro-instrumentation: one
// PostHog event when a knowledge object is created (any surface) and one when
// an actor opens one. Together they let the intended HogQL run — see the
// closed bet's Retro block ("What we'd cut next time") and the T-instrument
// task body for the query shape.
export const KNOWLEDGE_OBJECT_CREATED = 'knowledge_object_created'
export const KNOWLEDGE_OBJECT_READ = 'knowledge_object_read'

// Header the MCP server + web UI set on outbound API calls so the create/read
// routes can attribute events without guessing. Absent header falls back to
// actorType-based inference (see resolveCreatedVia / resolveAccessedVia).
export const CLIENT_SOURCE_HEADER = 'x-client-source'

export type KnowledgeCreatedVia = 'ui' | 'agent' | 'mcp'
export type KnowledgeAccessedVia = 'extension' | 'ui' | 'mcp'

// Maps the optional X-Client-Source header + actor type onto the ship-metric
// enum. MCP callers self-identify; agent CLIs that hit the API without going
// through MCP resolve to `agent`; anything else is `ui`.
export function resolveCreatedVia(
	clientSource: string | undefined,
	actorType: string | undefined,
): KnowledgeCreatedVia {
	if (clientSource === 'mcp') return 'mcp'
	if (clientSource === 'agent') return 'agent'
	if (clientSource === 'ui') return 'ui'
	if (actorType === 'agent') return 'agent'
	return 'ui'
}

// Read-side enum has no `agent` slot per the task spec — an agent that reads
// without going through MCP is unusual today, but map it to `mcp` because
// that's the intended agent read path (get_objects → MCP → API). `extension`
// is only honoured when the caller explicitly declares it.
export function resolveAccessedVia(
	clientSource: string | undefined,
	actorType: string | undefined,
): KnowledgeAccessedVia {
	if (clientSource === 'extension') return 'extension'
	if (clientSource === 'mcp') return 'mcp'
	if (clientSource === 'ui') return 'ui'
	if (actorType === 'agent') return 'mcp'
	return 'ui'
}

// Fires `knowledge_object_created` end-to-end for the Knowledge Extension
// retro-instrumentation. Fire-and-forget: a broken PostHog capture must never
// surface to the caller — analytics can't block object writes. The audit row
// for the create itself is already inserted by the route handler as
// `action='created'`, so this helper only emits the PostHog capture.
interface KnowledgeObjectCreatedProps {
	workspaceId: string
	actorId: string
	objectId: string
	createdVia: KnowledgeCreatedVia
}

export async function trackKnowledgeObjectCreated(p: KnowledgeObjectCreatedProps): Promise<void> {
	await capturePosthogEvent(KNOWLEDGE_OBJECT_CREATED, p.workspaceId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		object_id: p.objectId,
		created_via: p.createdVia,
	})
}

// Fires `knowledge_object_read` for the retro-instrumentation. Reads are not
// mutations, so no `events` audit row is inserted — that would flood both the
// events table and the PG NOTIFY → SSE bridge on every TanStack Query
// refetch or MCP get_objects call. PostHog capture only.
interface KnowledgeObjectReadProps {
	workspaceId: string
	actorId: string
	objectId: string
	accessedVia: KnowledgeAccessedVia
}

export async function trackKnowledgeObjectRead(p: KnowledgeObjectReadProps): Promise<void> {
	await capturePosthogEvent(KNOWLEDGE_OBJECT_READ, p.workspaceId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		object_id: p.objectId,
		accessed_via: p.accessedVia,
	})
}

interface WorkspaceKnowledgeReferencedProps {
	workspaceId: string
	// Caller reading the knowledge object.
	actorId: string
	// The knowledge object being read.
	entityId: string
	// The bet / insight / task the caller is acting on, if any.
	consumerContextId: string | null
	// `topic:` tags that matched to surface the knowledge object.
	sourceTopics: readonly string[]
}

// Emits the ship-metric event end-to-end: an `events` row (audit log + the
// PG NOTIFY → SSE feed T6 will read for the doc-header chip) plus a PostHog
// capture (the bet's success query). Both paths are fire-and-forget — a
// failed audit or PostHog call must never surface to the caller, so a
// `consult-knowledge` read can never fail on analytics.
export async function trackWorkspaceKnowledgeReferenced(
	db: DbHandle,
	p: WorkspaceKnowledgeReferencedProps,
): Promise<void> {
	try {
		await db.insert(events).values({
			workspaceId: p.workspaceId,
			actorId: p.actorId,
			action: WORKSPACE_KNOWLEDGE_REFERENCED,
			entityType: 'object',
			entityId: p.entityId,
			data: {
				consumer_context_id: p.consumerContextId,
				source_topics: [...p.sourceTopics],
			},
		})
	} catch (err) {
		logger.warn('workspace_knowledge_referenced DB insert failed', {
			actorId: p.actorId,
			entityId: p.entityId,
			error: String(err),
		})
	}

	// PostHog `properties` values are scalar-only (see `PosthogEventProps`),
	// so topics ship as a comma-joined string plus a count for numeric
	// aggregation in the ship-metric query.
	await capturePosthogEvent(WORKSPACE_KNOWLEDGE_REFERENCED, p.workspaceId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		entity_id: p.entityId,
		consumer_context_id: p.consumerContextId,
		source_topic_count: p.sourceTopics.length,
		source_topics: p.sourceTopics.join(','),
	})
}

// Auto-emit hook for the relationship-create path. Called with a fresh row
// (never on the ON CONFLICT no-op path — dup edges must not re-fire the ship
// metric per T2 idempotency clause). If the edge is `derived_from` and points
// at a `knowledge` object, this fires `workspace_knowledge_referenced` with
// the target's `topic:` tags as `source_topics` and the source id as
// `consumer_context_id`. Best-effort: any lookup or emit failure is logged
// and swallowed — a `consult-knowledge`-driven cite must never fail because
// analytics tripped.
interface KnowledgeReferenceEdgeHookProps {
	workspaceId: string
	actorId: string
	edgeType: string
	sourceId: string
	targetId: string
}

// Extract `topic:*` values from a knowledge object's `metadata.tags`. The
// tags field is a `text` schema value in `extensions/knowledge/shared.ts`,
// but existing corpus data stores it as either a comma-joined string OR a
// string array (see trigger-runner tests) — handle both without inventing
// a third shape.
function extractTopicTags(metadata: unknown): string[] {
	if (!metadata || typeof metadata !== 'object') return []
	const tags = (metadata as Record<string, unknown>).tags
	let candidates: string[] = []
	if (Array.isArray(tags)) {
		candidates = tags.filter((t): t is string => typeof t === 'string')
	} else if (typeof tags === 'string') {
		candidates = tags.split(',').map((s) => s.trim())
	}
	return candidates.filter((t) => t.startsWith('topic:'))
}

export async function maybeEmitKnowledgeReferenceFromEdge(
	db: DbHandle,
	p: KnowledgeReferenceEdgeHookProps,
): Promise<void> {
	if (p.edgeType !== 'derived_from') return
	try {
		const [target] = await db
			.select({ type: objects.type, metadata: objects.metadata })
			.from(objects)
			.where(eq(objects.id, p.targetId))
			.limit(1)
		if (!target || target.type !== 'knowledge') return
		const sourceTopics = extractTopicTags(target.metadata)
		await trackWorkspaceKnowledgeReferenced(db, {
			workspaceId: p.workspaceId,
			actorId: p.actorId,
			entityId: p.targetId,
			consumerContextId: p.sourceId,
			sourceTopics,
		})
	} catch (err) {
		logger.warn('workspace_knowledge_referenced edge hook failed', {
			actorId: p.actorId,
			sourceId: p.sourceId,
			targetId: p.targetId,
			error: String(err),
		})
	}
}
