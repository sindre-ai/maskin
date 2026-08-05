import { OpenAPIHono, type RouteHandler, createRoute } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, objects, subscriptions, triggers } from '@maskin/db/schema'
import { type LoopResponse, TERMINAL_BET_STATUSES, loopsListResponseSchema } from '@maskin/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

// Terminal statuses across the object types a loop can process. A child object
// (bet/task/insight/commitment) sitting in one of these counts toward
// `closed_count`; anything else counts toward `in_progress_count`. Task/insight
// use their own terminal set. Kept inline (not exported to @maskin/shared)
// because it's a per-endpoint aggregation policy — moving it into the
// shared schema would encourage other surfaces to reuse it as if it were the
// definition of "done," which it isn't.
const TASK_TERMINAL_STATUSES = ['done', 'discarded'] as const
const INSIGHT_TERMINAL_STATUSES = ['discarded'] as const
const COMMITMENT_TERMINAL_STATUSES: readonly string[] = []

function statusIsTerminal(type: string, status: string): boolean {
	if (type === 'bet') return (TERMINAL_BET_STATUSES as readonly string[]).includes(status)
	if (type === 'task') return (TASK_TERMINAL_STATUSES as readonly string[]).includes(status)
	if (type === 'insight') return (INSIGHT_TERMINAL_STATUSES as readonly string[]).includes(status)
	if (type === 'commitment') return COMMITMENT_TERMINAL_STATUSES.includes(status)
	// Unknown child types (a future extension) count as in-progress until the
	// endpoint learns their terminal set — never silently close them.
	return status === 'archived'
}

function readStringArray(metadata: unknown, key: string): string[] {
	if (!metadata || typeof metadata !== 'object') return []
	const raw = (metadata as Record<string, unknown>)[key]
	if (!Array.isArray(raw)) return []
	return raw.filter((v): v is string => typeof v === 'string')
}

function readString(metadata: unknown, key: string): string | null {
	if (!metadata || typeof metadata !== 'object') return null
	const value = (metadata as Record<string, unknown>)[key]
	return typeof value === 'string' && value.length > 0 ? value : null
}

function readInt(metadata: unknown, key: string): number | null {
	if (!metadata || typeof metadata !== 'object') return null
	const value = (metadata as Record<string, unknown>)[key]
	if (typeof value !== 'number' || !Number.isFinite(value)) return null
	return Math.trunc(value)
}

function median(sortedMs: number[]): number | null {
	if (sortedMs.length === 0) return null
	const mid = Math.floor(sortedMs.length / 2)
	if (sortedMs.length % 2 === 1) return sortedMs[mid] as number
	return ((sortedMs[mid - 1] as number) + (sortedMs[mid] as number)) / 2
}

const listLoopsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Loops'],
	summary: 'List loops (multi-agent pipelines) with derived per-row state',
	description:
		'Returns every `loop`-typed object in the workspace with per-viewer state ' +
		'computed at read time (in-progress/closed child counts, median close time, ' +
		'attached agent actor ids, and whether the caller has unread activity on any ' +
		'linked in-flight item). Empty workspaces return `{ loops: [] }`.',
	request: {
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			description: 'List of loops',
			content: { 'application/json': { schema: loopsListResponseSchema } },
		},
		400: {
			description: 'Invalid request',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listLoopsRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	// (1) Loops themselves. Scoped to workspace + type via a header-authorised
	// call — auth middleware has already verified membership before the
	// handler runs (see CLAUDE.md "Reviewer pitfall — do not flag missing
	// isWorkspaceMember on header-scoped routes").
	const loopRows = await db
		.select()
		.from(objects)
		.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'loop')))

	if (loopRows.length === 0) {
		return c.json({ loops: [] }, 200)
	}

	const loopIds = loopRows.map((l) => l.id)

	// (2) Child items linked via `metadata.loop_id`. Fetch only the columns
	// needed to bucket into in-progress / closed and compute a median close
	// time. Scoped to workspace — a stray loop_id on a foreign object cannot
	// leak in because the workspaceId filter binds the join.
	const childRows = await db
		.select({
			type: objects.type,
			status: objects.status,
			loopId: sql<string>`${objects.metadata}->>'loop_id'`,
			createdAt: objects.createdAt,
			updatedAt: objects.updatedAt,
		})
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				sql`${objects.metadata}->>'loop_id' = ANY(${loopIds}::text[])`,
			),
		)

	const inProgressByLoop = new Map<string, number>()
	const closedByLoop = new Map<string, number>()
	const closedMsByLoop = new Map<string, number[]>()
	for (const row of childRows) {
		const loopId = row.loopId
		if (!loopId) continue
		const terminal = statusIsTerminal(row.type, row.status)
		if (terminal) {
			closedByLoop.set(loopId, (closedByLoop.get(loopId) ?? 0) + 1)
			if (row.createdAt instanceof Date && row.updatedAt instanceof Date) {
				const ms = row.updatedAt.getTime() - row.createdAt.getTime()
				if (Number.isFinite(ms) && ms >= 0) {
					const arr = closedMsByLoop.get(loopId) ?? []
					arr.push(ms)
					closedMsByLoop.set(loopId, arr)
				}
			}
		} else {
			inProgressByLoop.set(loopId, (inProgressByLoop.get(loopId) ?? 0) + 1)
		}
	}

	// (3) Agents attached via `metadata.trigger_ids`. One bulk query for every
	// trigger id referenced by any loop; grouped in JS.
	const allTriggerIds = Array.from(
		new Set(loopRows.flatMap((l) => readStringArray(l.metadata, 'trigger_ids'))),
	)
	const triggerRows = allTriggerIds.length
		? await db
				.select({ id: triggers.id, targetActorId: triggers.targetActorId })
				.from(triggers)
				.where(and(eq(triggers.workspaceId, workspaceId), inArray(triggers.id, allTriggerIds)))
		: []
	const actorByTrigger = new Map<string, string>()
	for (const t of triggerRows) actorByTrigger.set(t.id, t.targetActorId)

	// (4) `waiting_on_viewer`: does the caller have any unread event on any
	// child object of this loop? Mirrors the unread-feed pattern in
	// routes/subscriptions.ts — a stale subscription row alone doesn't count;
	// there must be an event past the actor's read high-water-mark that the
	// caller did not author. Grouped per loop_id in one query.
	//
	// The correlated `read_state` subquery is intentionally table-qualified
	// literal SQL (`read_state.entity_id = subscriptions.entity_id`) instead
	// of interpolated Drizzle column objects — Drizzle renders column objects
	// inside correlated `sql` templates without their table qualifier, which
	// on an inner table sharing a column name silently binds to the wrong
	// side. See .claude/rules/known-pitfalls.md (rule "Drizzle Column Objects
	// in a Correlated sql Subquery Render Unqualified").
	const waitingRows = await db
		.select({
			loopId: sql<string>`${objects.metadata}->>'loop_id'`,
		})
		.from(subscriptions)
		.innerJoin(
			objects,
			and(
				eq(subscriptions.entityType, 'object'),
				eq(objects.id, subscriptions.entityId),
				eq(objects.workspaceId, workspaceId),
			),
		)
		.innerJoin(
			events,
			and(
				eq(events.workspaceId, subscriptions.workspaceId),
				eq(events.entityId, subscriptions.entityId),
				sql`${events.actorId} <> ${actorId}`,
				sql`${events.id} > coalesce(
					(select last_read_event_id from read_state
						where read_state.actor_id = ${actorId}
							and read_state.entity_type = subscriptions.entity_type
							and read_state.entity_id = subscriptions.entity_id),
					0
				)`,
			),
		)
		.where(
			and(
				eq(subscriptions.workspaceId, workspaceId),
				eq(subscriptions.actorId, actorId),
				sql`${objects.metadata}->>'loop_id' = ANY(${loopIds}::text[])`,
			),
		)
		.groupBy(sql`${objects.metadata}->>'loop_id'`)

	const waitingLoopIds = new Set(waitingRows.map((r) => r.loopId).filter(Boolean))

	const loops: LoopResponse[] = loopRows.map((row) => {
		const meta = (row.metadata as Record<string, unknown> | null) ?? {}
		const triggerIds = readStringArray(meta, 'trigger_ids')
		const agentIds = Array.from(
			new Set(
				triggerIds
					.map((id) => actorByTrigger.get(id))
					.filter((v): v is string => typeof v === 'string'),
			),
		)
		const closedMs = closedMsByLoop.get(row.id) ?? []
		const sorted = [...closedMs].sort((a, b) => a - b)
		const status = ((): 'running' | 'waiting' | 'paused' | 'archived' => {
			if (
				row.status === 'running' ||
				row.status === 'waiting' ||
				row.status === 'paused' ||
				row.status === 'archived'
			) {
				return row.status
			}
			// A loop row carrying an unregistered status is a schema drift signal —
			// don't silently coerce to `running`; keep the raw value out of the
			// response by treating it as `archived` (silent). If this fires the
			// registration is wrong somewhere and needs fixing at the source.
			return 'archived'
		})()

		return {
			id: row.id,
			name: row.title,
			guarantee: row.content,
			status,
			entry_condition: readString(meta, 'entry_condition'),
			close_condition: readString(meta, 'close_condition'),
			human_decision_points: readInt(meta, 'human_decision_points'),
			trigger_ids: triggerIds,
			installed_from_package_id: readString(meta, 'installed_from_package_id'),
			in_progress_count: inProgressByLoop.get(row.id) ?? 0,
			closed_count: closedByLoop.get(row.id) ?? 0,
			median_time_to_close_ms: median(sorted),
			agent_ids: agentIds,
			waiting_on_viewer: waitingLoopIds.has(row.id),
			created_at: row.createdAt instanceof Date ? row.createdAt.toISOString() : null,
			updated_at: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : null,
		}
	})

	return c.json({ loops }, 200)
}) as RouteHandler<typeof listLoopsRoute, Env>)

export default app
