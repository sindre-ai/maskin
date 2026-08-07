import { OpenAPIHono, type RouteHandler, createRoute } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, objects, readState, relationships, triggers } from '@maskin/db/schema'
import { TERMINAL_BET_STATUSES, listLoopsResponseSchema } from '@maskin/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'

/** Loose UUID match — used to filter free-form `metadata.trigger_ids` entries
 * before they reach a query. Guards two things at once: an attacker-controlled
 * string can never reach `sql.raw()` (see `loopIdArray`-style array literals
 * elsewhere in this file), and a malformed id in the metadata can't crash the
 * whole `/api/loops` response with a Postgres "invalid input syntax for type
 * uuid" error — it's just silently dropped, same as any other stale id. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Relationship `type` marking "this object is a member of this loop's
 * pipeline" — `source_id` is the loop, `target_id` is the child object.
 * Not part of the workspace's user-facing `relationship_types` list (that's
 * for narrative connections a human picks from a dropdown); this one is
 * written structurally, the same way `create_objects`/`update_objects`
 * write any other edge. */
const LOOP_MEMBERSHIP_RELATIONSHIP_TYPE = 'in_loop'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

/**
 * Terminal statuses per object type — a child object in one of these values
 * counts toward the loop's `closedCount` and drops out of `inProgressCount`.
 * `bet` is `TERMINAL_BET_STATUSES` (`packages/shared/src/schemas/objects.ts`)
 * *plus* `archived` — a deliberate, loop-scoped superset, not a mirror.
 * `TERMINAL_BET_STATUSES` excludes `archived` on purpose (archiving a bet is
 * a silent move that must not fan out a retro or unread-feed row), but that's
 * a "does this warrant a notification" definition, not a "is this bet still
 * active work" one. For loop progress tracking, an archived bet has stopped
 * moving either way, so it belongs in `closedCount` here even though it never
 * triggers the bet-terminal watcher signal.
 * `task` mirrors the done-set the CTO/validation flow treats as complete.
 * `insight`'s only closed state today is `discarded` (see workspace-briefing's
 * `ne(objects.status, 'discarded')` filter for open insights).
 *
 * Kept as a per-type table here rather than shared because the read API is
 * the only consumer today; if a second consumer appears, promote to
 * `packages/shared/src/schemas/objects.ts` alongside `TERMINAL_BET_STATUSES`.
 */
const TERMINAL_STATUSES_BY_TYPE: Record<string, string[]> = {
	bet: [...TERMINAL_BET_STATUSES, 'archived'],
	task: ['done', 'validated', 'discarded'],
	insight: ['discarded'],
	commitment: [], // commitments never terminate — they're standing state
}

const TERMINAL_STATUS_LITERAL_LIST = sql.raw(
	`(${Object.entries(TERMINAL_STATUSES_BY_TYPE)
		.flatMap(([type, statuses]) => statuses.map((s) => `('${type}','${s}')`))
		.join(',')})`,
)

const listLoopsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['loops'],
	summary: 'List loops in workspace with derived stats',
	description:
		'Returns every Loop object in the workspace with per-row derived fields (in-progress / closed counts, median close time, agent-actor ids, per-viewer waiting flag) computed from a single request. Returns an empty array — not an error — for workspaces with zero loops.',
	request: {
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			description: 'List of loops with derived stats',
			content: { 'application/json': { schema: listLoopsResponseSchema } },
		},
		400: {
			description: 'Missing workspace ID',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listLoopsRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	// Load every Loop in the workspace. `list_objects`-style read; the derived
	// per-row fields below fan out to child objects / triggers / read state in
	// separate batched queries so N stays small (5 queries total regardless
	// of the number of loops).
	const loopRows = await db
		.select()
		.from(objects)
		.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'loop')))
	if (loopRows.length === 0) {
		return c.json({ loops: [] })
	}

	const loopIds = loopRows.map((l) => l.id)

	// Trigger ids referenced in metadata.trigger_ids. Membership lives on the
	// loop row (per T1(b)) since triggers can outlive their loop. Collect
	// unique ids across all loops so the actor lookup can be a single query.
	type LoopMetaTriggers = { triggerIds: string[]; loopId: string }
	const perLoopTriggers: LoopMetaTriggers[] = loopRows.map((l) => {
		const meta = (l.metadata as Record<string, unknown> | null) ?? {}
		const raw = meta.trigger_ids
		const triggerIds = Array.isArray(raw)
			? raw.filter((v): v is string => typeof v === 'string' && UUID_RE.test(v))
			: []
		return { loopId: l.id, triggerIds }
	})
	const allTriggerIds = Array.from(new Set(perLoopTriggers.flatMap((r) => r.triggerIds)))

	// Aggregate queries — each returns one row per loop id. Membership is a
	// real relationship edge (`type='in_loop'`, source=loop, target=child) —
	// child objects don't carry a `metadata.loop_id` back-reference; the loop
	// row is the source of truth for who's a member, same as any other edge.
	//
	// `= ANY(...)` filters to only loops we're rendering (skip stragglers
	// pointing at unknown ids).
	const loopIdArray = sql.raw(`ARRAY[${loopIds.map((id) => `'${id}'`).join(',')}]::uuid[]`)

	// Per-loop child-object counts + median close time in a single scan.
	const childStatsRows = await db.execute<{
		loop_id: string
		in_progress_count: number
		closed_count: number
		median_close_ms: number | null
	}>(
		sql`
			SELECT
				r.source_id AS loop_id,
				COUNT(*) FILTER (
					WHERE (o.type, o.status) NOT IN ${TERMINAL_STATUS_LITERAL_LIST}
				)::int AS in_progress_count,
				COUNT(*) FILTER (
					WHERE (o.type, o.status) IN ${TERMINAL_STATUS_LITERAL_LIST}
				)::int AS closed_count,
				percentile_cont(0.5) WITHIN GROUP (
					ORDER BY EXTRACT(EPOCH FROM (o.updated_at - o.created_at)) * 1000
				) FILTER (
					WHERE (o.type, o.status) IN ${TERMINAL_STATUS_LITERAL_LIST}
				) AS median_close_ms
			FROM ${relationships} r
			JOIN ${objects} o ON o.id = r.target_id
			WHERE r.type = ${LOOP_MEMBERSHIP_RELATIONSHIP_TYPE}
				AND r.source_id = ANY(${loopIdArray})
				AND o.workspace_id = ${workspaceId}
			GROUP BY r.source_id
		`,
	)

	const childStatsByLoop = new Map<
		string,
		{ inProgressCount: number; closedCount: number; medianCloseMs: number | null }
	>()
	for (const row of childStatsRows) {
		childStatsByLoop.set(row.loop_id, {
			inProgressCount: Number(row.in_progress_count) || 0,
			closedCount: Number(row.closed_count) || 0,
			medianCloseMs:
				row.median_close_ms === null || row.median_close_ms === undefined
					? null
					: Math.round(Number(row.median_close_ms)),
		})
	}

	// Trigger → agent lookup (batched across all loops).
	const agentIdByTrigger = new Map<string, string>()
	if (allTriggerIds.length > 0) {
		const triggerRows = await db
			.select({ id: triggers.id, targetActorId: triggers.targetActorId })
			.from(triggers)
			.where(and(eq(triggers.workspaceId, workspaceId), inArray(triggers.id, allTriggerIds)))
		for (const t of triggerRows) {
			if (t.targetActorId) agentIdByTrigger.set(t.id, t.targetActorId)
		}
	}

	// Per-viewer "waiting on you" flag: does the viewer have any unread event
	// on any object currently linked to this loop? Reuses the `read_state`
	// last-read expression pattern from `subscriptions.ts`. Unlike
	// `getUnreadCount` (which filters `action = 'commented'` to count unread
	// comments specifically), this matches ANY event on the child object —
	// a status/lifecycle change is exactly the "needs a human" signal this
	// flag exists for, and those events are logged with `entity_type` set to
	// the object's concrete type (task/bet/insight), not `'object'` (that
	// value is reserved for comment events — see objects.ts's object-detail
	// route). So we match on `entity_id` alone, which already scopes
	// precisely to this one object regardless of which entity_type the event
	// was logged under. `read_state` itself is always keyed by the generic
	// `entity_type = 'object'` for objects, so that half stays fixed.
	// A loop with zero child objects always resolves to false.
	const waitingRows = await db.execute<{ loop_id: string; waiting: boolean }>(
		sql`
			SELECT
				r.source_id AS loop_id,
				EXISTS (
					SELECT 1
					FROM ${events} e
					WHERE e.workspace_id = ${workspaceId}
						AND e.entity_id = o.id
						AND e.actor_id <> ${actorId}
						AND e.id > COALESCE(
							(
								SELECT last_read_event_id FROM ${readState}
								WHERE actor_id = ${actorId}
									AND entity_type = 'object'
									AND entity_id = o.id
							),
							0
						)
				) AS waiting
			FROM ${relationships} r
			JOIN ${objects} o ON o.id = r.target_id
			WHERE r.type = ${LOOP_MEMBERSHIP_RELATIONSHIP_TYPE}
				AND r.source_id = ANY(${loopIdArray})
				AND o.workspace_id = ${workspaceId}
			GROUP BY r.source_id, o.id
		`,
	)

	// A loop is "waiting on viewer" if ANY of its child objects has unread
	// events for the viewer — collapse the per-child rows here.
	const waitingByLoop = new Map<string, boolean>()
	for (const row of waitingRows) {
		waitingByLoop.set(row.loop_id, waitingByLoop.get(row.loop_id) === true || row.waiting === true)
	}

	const response = {
		loops: loopRows.map((row) => {
			const rawStatus = row.status
			const status = ((): 'running' | 'waiting' | 'paused' | 'archived' => {
				if (
					rawStatus === 'running' ||
					rawStatus === 'waiting' ||
					rawStatus === 'paused' ||
					rawStatus === 'archived'
				) {
					return rawStatus
				}
				// Unknown status (shouldn't happen with schema-validated statuses,
				// but preserved so a manual UPDATE cannot 500 the endpoint).
				return 'running'
			})()

			const meta = (row.metadata as Record<string, unknown> | null) ?? {}
			const entryCondition =
				typeof meta.entry_condition === 'string' && meta.entry_condition.length > 0
					? meta.entry_condition
					: null
			const closeCondition =
				typeof meta.close_condition === 'string' && meta.close_condition.length > 0
					? meta.close_condition
					: null
			const humanDecisionPointsRaw = meta.human_decision_points
			const humanDecisionPoints =
				typeof humanDecisionPointsRaw === 'number' &&
				Number.isFinite(humanDecisionPointsRaw) &&
				humanDecisionPointsRaw >= 0
					? Math.floor(humanDecisionPointsRaw)
					: null

			const stats = childStatsByLoop.get(row.id) ?? {
				inProgressCount: 0,
				closedCount: 0,
				medianCloseMs: null,
			}
			const triggerIds =
				perLoopTriggers.find((t) => t.loopId === row.id)?.triggerIds ?? ([] as string[])
			const agentIds = Array.from(
				new Set(
					triggerIds
						.map((id) => agentIdByTrigger.get(id))
						.filter((v): v is string => typeof v === 'string'),
				),
			)
			const waitingOnViewer = waitingByLoop.get(row.id) === true

			// Composite pill signal per T1(c). Lifecycle overrides everything:
			// paused/archived stay grey regardless of read state; only `running`
			// composes with waitingOnViewer. An explicit `waiting` status forces
			// the amber "waiting" pill even if the viewer has no unread events —
			// the workspace has already declared the loop needs attention.
			const pill: 'running' | 'waiting_on_you' | 'paused' | 'archived' =
				status === 'paused' || status === 'archived'
					? status
					: status === 'waiting'
						? 'waiting_on_you'
						: waitingOnViewer
							? 'waiting_on_you'
							: 'running'

			return {
				id: row.id,
				workspaceId: row.workspaceId,
				name: row.title,
				guarantee: row.content,
				status,
				pill,
				entryCondition,
				closeCondition,
				humanDecisionPoints,
				inProgressCount: stats.inProgressCount,
				closedCount: stats.closedCount,
				medianTimeToCloseMs: stats.medianCloseMs,
				agentIds,
				triggerIds,
				waitingOnViewer,
				createdAt: row.createdAt ? row.createdAt.toISOString() : null,
				updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
			}
		}),
	}

	return c.json(response)
}) as RouteHandler<typeof listLoopsRoute, Env>)

export default app
