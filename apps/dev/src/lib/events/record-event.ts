import type { Database, Transaction } from '@maskin/db'
import { events, relationships, sessions } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { capturePosthogEvent } from '../analytics/posthog'
import { FLAGS, isFlagEnabled } from '../feature-flags'
import { logger } from '../logger'

// Accepts both a `Database` (top-level connection) and a `Transaction`
// (inside a `db.transaction((tx) => …)` block), so a caller inside a
// transaction can pass its `tx` and stay in the same commit. Every call site
// in the codebase reads as one of these two shapes.
export type EventsWriter = Database | Transaction

// The two provenance-relevant object endpoints — the writer hook can only
// upsert a `session → object|file` `produced_by` edge when the mutation is
// on one of these. Every other event type (integration, workspace, trigger,
// …) is audit-only and gets no provenance write.
export type ProvenanceEndpointKind = 'object' | 'file'

/**
 * Opt-in provenance context. Pass only when the mutation is on a row in
 * `objects` or `files`. When both `sessionId` and `entityKind` are set AND
 * the `graph-provenance-writes` flag is on for the session's actor, the
 * helper upserts a `session → entity` `produced_by` relationship after the
 * event row lands. Any other combination is a no-op — the mutation still
 * succeeds silently, no lineage rows land (spec §Rabbit holes:
 * "absence = no edge = no lineage, never 'unknown'").
 *
 * `sessionId` MAY be `null | undefined` — that's the common case for a human
 * writing directly in the UI. The provenance write is guarded on truthiness.
 */
export interface ProvenanceContext {
	sessionId?: string | null
	entityKind?: ProvenanceEndpointKind
}

export interface RecordEventParams {
	workspaceId: string
	actorId: string
	action: string
	entityType: string
	entityId: string
	data?: unknown
	/**
	 * Opt-in on object/file mutations. Non-object writes leave this unset and
	 * the helper is a straight audit-log write — behaviour-identical to the
	 * inline `db.insert(events)` it replaces.
	 */
	provenance?: ProvenanceContext
}

/**
 * The single centralized writer for the `events` audit-log table. Every
 * mutation across `apps/dev/src` calls this — a route handler adding a
 * `db.insert(events).values(...)` in a new PR must reach for `recordEvent`
 * instead, so the writer hook cannot silently miss a call site. The pre-
 * commit grep for `db.insert(events)` returns zero prod-code hits.
 *
 * Behaviour parity with the inline pattern it replaces: same column set,
 * same fire-and-forget event insert. The provenance write is a strict
 * superset — it only fires when the caller opts in with `provenance`, the
 * flag is on for the session's actor, and both `sessionId` and `entityKind`
 * are truthy. A provenance-write failure is swallowed and logged; the
 * mutation and its audit row are already committed.
 */
export async function recordEvent(dbOrTx: EventsWriter, params: RecordEventParams): Promise<void> {
	await dbOrTx.insert(events).values({
		workspaceId: params.workspaceId,
		actorId: params.actorId,
		action: params.action,
		entityType: params.entityType,
		entityId: params.entityId,
		data: (params.data ?? null) as unknown as never,
	})

	const provenance = params.provenance
	if (!provenance?.sessionId || !provenance.entityKind) return

	try {
		await writeProducedByEdge(dbOrTx, {
			workspaceId: params.workspaceId,
			sessionId: provenance.sessionId,
			entityKind: provenance.entityKind,
			entityId: params.entityId,
		})
	} catch (err) {
		// Never let a lineage-write failure roll back the mutation or its audit
		// row: `produced_by` is annotation-quality, not authoritative. Log and
		// move on so a broken flag lookup or transient CHECK failure never
		// takes a real write down with it.
		logger.warn('produced_by edge write failed', {
			workspaceId: params.workspaceId,
			entityId: params.entityId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Batch variant. Same shape as `recordEvent` but writes multiple rows in
 * one INSERT — used by the handful of routes that fan out N event rows in
 * one transaction (imports, agent-skill attachments, triggers). Provenance
 * is intentionally not supported on the batch path: every provenance-
 * eligible mutation this codebase writes goes through `recordEvent`
 * directly.
 */
export async function recordEvents(
	dbOrTx: EventsWriter,
	rows: Array<Omit<RecordEventParams, 'provenance'>>,
): Promise<void> {
	if (rows.length === 0) return
	await dbOrTx.insert(events).values(
		rows.map((r) => ({
			workspaceId: r.workspaceId,
			actorId: r.actorId,
			action: r.action,
			entityType: r.entityType,
			entityId: r.entityId,
			data: (r.data ?? null) as unknown as never,
		})),
	)
}

/**
 * `recordEvent` variant that returns the inserted row — for the small set
 * of callers that need the freshly-minted `events.id` immediately (comment
 * posts key subscriptions off it, for one). Same event-write behaviour;
 * provenance is intentionally NOT supported on this path because the only
 * caller today (`postComment`) writes a `commented` event whose entity is
 * a task/bet/insight but which is not itself a session-owned mutation
 * (it's a user comment).
 */
export async function recordEventReturning(
	dbOrTx: EventsWriter,
	params: Omit<RecordEventParams, 'provenance'>,
): Promise<typeof events.$inferSelect> {
	const [row] = await dbOrTx
		.insert(events)
		.values({
			workspaceId: params.workspaceId,
			actorId: params.actorId,
			action: params.action,
			entityType: params.entityType,
			entityId: params.entityId,
			data: (params.data ?? null) as unknown as never,
		})
		.returning()
	if (!row) throw new Error('recordEventReturning: insert returned no row')
	return row
}

/**
 * Upsert a `session → object|file` `produced_by` relationship — the S2
 * writer hook's core write. Idempotent on `(source_id, target_id, type)`
 * per the unique index, so a re-run over the same mutation (retry, restart)
 * never double-writes. Flag-gated on the session's actor:
 * `graph-provenance-writes` OFF for that actor means the function is a
 * no-op and no PostHog event fires.
 */
async function writeProducedByEdge(
	dbOrTx: EventsWriter,
	params: {
		workspaceId: string
		sessionId: string
		entityKind: ProvenanceEndpointKind
		entityId: string
	},
): Promise<void> {
	// Look up the session's actor to evaluate the flag against — the header
	// promises the sessionId, and the flag is per-driver-actor. A session
	// whose row was deleted (rare: cascade from actor delete) is treated as
	// flag-off; no edge is written.
	const [session] = await dbOrTx
		.select({ actorId: sessions.actorId })
		.from(sessions)
		.where(eq(sessions.id, params.sessionId))
		.limit(1)
	if (!session) return

	const flagOn = isFlagEnabled(session.actorId, FLAGS.GRAPH_PROVENANCE_WRITES)
	if (!flagOn) return

	const [inserted] = await dbOrTx
		.insert(relationships)
		.values({
			sourceType: 'session',
			sourceId: params.sessionId,
			targetType: params.entityKind,
			targetId: params.entityId,
			type: 'produced_by',
			createdBy: session.actorId,
		})
		.onConflictDoNothing({
			target: [relationships.sourceId, relationships.targetId, relationships.type],
		})
		.returning({ id: relationships.id })

	// A conflicting row already exists: same edge already written by a prior
	// call (idempotent retry, dispatcher redelivery). No PostHog event fires
	// — this is not a new edge.
	if (!inserted) return

	// One capture per writer path per event, per the spec's "PostHog events
	// ship in the same PR as the feature" call. Fire-and-forget: analytics
	// is never a critical path.
	capturePosthogEvent('relationship_created', session.actorId, {
		workspace_id: params.workspaceId,
		source_type: 'session',
		target_type: params.entityKind,
		type: 'produced_by',
	}).catch(() => {})
	capturePosthogEvent('provenance_edge_written', session.actorId, {
		workspace_id: params.workspaceId,
		edge_type: 'produced_by',
		flag_on: true,
	}).catch(() => {})
}

/**
 * Upsert a `conversation → session` `spawned` relationship — the S2 writer
 * hook's other write, fired from `SessionManager.createSession` after the
 * `sessions` row lands (and after the `session_created` event is recorded).
 * The `messageId` that triggered the spawn is persisted on
 * `relationships.metadata` so Task 4's deep-link can hit the exact chat
 * message.
 *
 * Guardrails identical to `writeProducedByEdge`: flag-gated on the
 * session's actor, idempotent on `(source_id, target_id, type)`. A `null`
 * or missing `messageId` still writes the edge (the spawn is still valid
 * provenance); `metadata` is just `null` for that row.
 *
 * Exported because the session CREATE path is the only writer — this is
 * not a general helper, unlike `recordEvent`.
 */
export async function writeSpawnedEdge(
	dbOrTx: EventsWriter,
	params: {
		workspaceId: string
		conversationId: string
		sessionId: string
		sessionActorId: string
		messageId: number | null
	},
): Promise<void> {
	const flagOn = isFlagEnabled(params.sessionActorId, FLAGS.GRAPH_PROVENANCE_WRITES)
	if (!flagOn) return

	try {
		const [inserted] = await dbOrTx
			.insert(relationships)
			.values({
				sourceType: 'conversation',
				sourceId: params.conversationId,
				targetType: 'session',
				targetId: params.sessionId,
				type: 'spawned',
				metadata:
					params.messageId != null ? ({ messageId: params.messageId } as unknown as never) : null,
				createdBy: params.sessionActorId,
			})
			.onConflictDoNothing({
				target: [relationships.sourceId, relationships.targetId, relationships.type],
			})
			.returning({ id: relationships.id })

		if (!inserted) return

		capturePosthogEvent('relationship_created', params.sessionActorId, {
			workspace_id: params.workspaceId,
			source_type: 'conversation',
			target_type: 'session',
			type: 'spawned',
		}).catch(() => {})
		capturePosthogEvent('provenance_edge_written', params.sessionActorId, {
			workspace_id: params.workspaceId,
			edge_type: 'spawned',
			flag_on: true,
		}).catch(() => {})
	} catch (err) {
		// Same discipline as `writeProducedByEdge`: never let a lineage-write
		// failure roll back the sessions insert or its `session_created`
		// event. Sessions are the load-bearing row; `spawned` is annotation
		// on top.
		logger.warn('spawned edge write failed', {
			workspaceId: params.workspaceId,
			conversationId: params.conversationId,
			sessionId: params.sessionId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Ship-metric fire for every relationship write that isn't the writer
 * hook's own (which fires its own event above). Called from every prod
 * writer of `relationships` — the two centralised routes
 * (`relationships.ts`, `graph.ts`), the two provider paths that back-fill
 * from external data (`google-meet/synth-event.ts`,
 * `google-meet/meeting-metadata.ts`), and the ingestion path
 * (`import-processor.ts`). Same fire-and-forget contract as the other
 * capture calls in this file.
 */
export function capturePosthogRelationshipCreated(
	actorId: string,
	params: { workspaceId: string; sourceType: string; targetType: string; type: string },
): void {
	capturePosthogEvent('relationship_created', actorId, {
		workspace_id: params.workspaceId,
		source_type: params.sourceType,
		target_type: params.targetType,
		type: params.type,
	}).catch(() => {})
}
