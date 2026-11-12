import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	files,
	objects,
	relationships,
	sessions,
	triggers,
	workspaceMembers,
} from '@maskin/db/schema'
import { TARGET_OF_RELATIONSHIP_TYPE, TARGET_TYPE } from '@maskin/ext-targets/shared'
import {
	type LoopTarget,
	SAFE_METADATA_FIELD_NAME_RE,
	TERMINAL_STATUSES_BY_TYPE,
	findChange,
	getChangesFromEventData,
	listLoopBriefingsResponseSchema,
	listLoopStepsResponseSchema,
	listLoopsResponseSchema,
	loopNextStepsResponseSchema,
	loopTargetSchema,
	normalizeTags,
	readChanges,
} from '@maskin/shared'
import { and, asc, desc, eq, inArray, notInArray, or, sql } from 'drizzle-orm'
import { validationFailureHook } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, eventResponseSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serializeArray } from '../lib/serialize'

/** Loose UUID match — used to filter free-form `metadata.trigger_ids` entries
 * before they reach a query. Guards two things at once: an attacker-controlled
 * string can never reach `sql.raw()` (see `loopIdArray`-style array literals
 * elsewhere in this file), and a malformed id in the metadata can't crash the
 * whole `/api/loops` response with a Postgres "invalid input syntax for type
 * uuid" error — it's just silently dropped, same as any other stale id. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Ids per `events` lookup. One query over every closed member of every loop
 * (1,000+ ids) is a long scan that outlives the statement timeout on a busy
 * database; small batches stay on the index and fail independently. */
const EVENT_LOOKUP_CHUNK = 200

type LoopEventRow = { entityId: string; data: unknown; createdAt: Date | null }

/** Events for a set of objects, fetched in id batches. Best-effort: the close
 * times these feed are enrichment with an `updated_at` fallback, so a slow or
 * failed batch is logged and skipped rather than failing the whole loops list.
 * A skipped object simply has no events and takes that fallback. */
async function fetchEventsForObjects(
	db: Database,
	workspaceId: string,
	entityIds: string[],
	actions: string[],
): Promise<LoopEventRow[]> {
	const rows: LoopEventRow[] = []
	for (let i = 0; i < entityIds.length; i += EVENT_LOOKUP_CHUNK) {
		const chunk = entityIds.slice(i, i + EVENT_LOOKUP_CHUNK)
		try {
			const part = await db
				.select({ entityId: events.entityId, createdAt: events.createdAt, data: events.data })
				.from(events)
				.where(
					and(
						eq(events.workspaceId, workspaceId),
						inArray(events.entityId, chunk),
						inArray(events.action, actions),
					),
				)
				.orderBy(events.id)
			rows.push(...part)
		} catch (err) {
			logger.warn('Loop close-time event lookup failed; falling back to updated_at', {
				workspaceId,
				chunkSize: chunk.length,
				error: String(err),
			})
		}
	}
	return rows
}

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

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

/**
 * This route only implements GET — there is intentionally no POST/PATCH/DELETE
 * here. A loop is just an `objects` row with `type = 'loop'`, so creating,
 * updating, and deleting one is done through the existing generic endpoints
 * (POST /api/graph, PATCH/DELETE /api/objects/:id, POST /api/triggers,
 * POST/DELETE /api/relationships) rather than a loop-specific write API.
 * `create_loop` / `update_loop` / `delete_loop` in `packages/mcp/src/server.ts`
 * are the supported way to perform those writes correctly (wiring
 * `metadata.trigger_ids` and `in_loop` edges) — see the comment above their
 * registration for the full breakdown of which endpoint each step hits.
 */

/**
 * `TERMINAL_STATUSES_BY_TYPE` (shared) is the FALLBACK for what counts as
 * closed per object type. A loop can carry its own `metadata.closed_statuses`
 * map (`{ <type>: [statuses...] }`, written by the MCP create_loop/update_loop
 * tools) that overrides the entry for a type — that's what makes closed counts
 * work for workspace-defined custom object types, which by definition can never
 * appear in a hardcoded table.
 */

/**
 * Extract a loop's `metadata.closed_statuses` override map, shape-validated:
 * a plain object of type → string[]. Anything malformed (arrays at the top
 * level, non-string entries) is dropped rather than erroring — same tolerance
 * as `trigger_ids` above, a hand-edited metadata blob must not 500 the page.
 */
function readClosedStatuses(meta: Record<string, unknown>): Record<string, string[]> | null {
	const raw = meta.closed_statuses
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
	const cleaned: Record<string, string[]> = {}
	for (const [type, value] of Object.entries(raw as Record<string, unknown>)) {
		if (Array.isArray(value)) {
			cleaned[type] = value.filter((s): s is string => typeof s === 'string')
		}
	}
	return Object.keys(cleaned).length > 0 ? cleaned : null
}

/** One `closed_when` rule: a member counts as closed when `metadata[field] === value`. */
type ClosedWhenRule = { field: string; value: string }

/**
 * Extract a loop's `metadata.closed_when` map: `{ <type>: ["<field>=<value>", ...] }`,
 * e.g. `{ insight: ["loop_stage=live"] }`. A member of that type is closed when
 * ANY of its rules matches (so two entries for one field read as "in [a, b]").
 * The shape is the same string-array map as `closed_statuses` because that is the
 * only nested metadata shape the write path accepts. Entries that are not
 * `field=value` with a safe field name are dropped rather than erroring, same
 * tolerance as `readClosedStatuses`.
 */
function readClosedWhen(meta: Record<string, unknown>): Record<string, ClosedWhenRule[]> | null {
	const raw = meta.closed_when
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
	const cleaned: Record<string, ClosedWhenRule[]> = {}
	for (const [type, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!Array.isArray(value)) continue
		const rules: ClosedWhenRule[] = []
		for (const entry of value) {
			if (typeof entry !== 'string') continue
			const sep = entry.indexOf('=')
			if (sep <= 0) continue
			const field = entry.slice(0, sep)
			const ruleValue = entry.slice(sep + 1)
			if (!SAFE_METADATA_FIELD_NAME_RE.test(field) || ruleValue.length === 0) continue
			rules.push({ field, value: ruleValue })
		}
		if (rules.length > 0) cleaned[type] = rules
	}
	return Object.keys(cleaned).length > 0 ? cleaned : null
}

function matchesClosedWhen(rules: ClosedWhenRule[], metadata: unknown): boolean {
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false
	const meta = metadata as Record<string, unknown>
	return rules.some((rule) => meta[rule.field] === rule.value)
}

/**
 * Extract a loop's `metadata.targets` (bet D5). Returns `null` when the field
 * is absent, not an array, or every row inside failed Zod validation — the
 * frontend then renders no `<TargetsAndOwners>` section. Malformed individual
 * entries are dropped rather than 500-ing the whole `/api/loops` response,
 * same tolerance the rest of this file already gives hand-edited metadata.
 */
function readLoopTargets(meta: Record<string, unknown>): LoopTarget[] | null {
	const raw = meta.targets
	if (!Array.isArray(raw)) return null
	const cleaned: LoopTarget[] = []
	for (const entry of raw) {
		const parsed = loopTargetSchema.safeParse(entry)
		if (parsed.success) cleaned.push(parsed.data)
	}
	return cleaned.length > 0 ? cleaned : null
}

/** Target objects in these statuses are not shown on a flow. */
const HIDDEN_TARGET_STATUSES = ['dropped', 'archived']

type TargetObjectRow = {
	title: string
	driver: string | null
	metadata: unknown
}

/**
 * A flow's targets list from its target objects (linked with `target_of`).
 * Same row shape as `readLoopTargets`: title is the label, driver the owner.
 * Where the object has no `actual` number, the actual (and `pace_policy`) of
 * the old row with the same label is kept, so a hand-set actual still shows.
 * Rows that fail the shape check are dropped, like the old rows. `null` when
 * nothing usable is left, so the caller can fall back to the old rows.
 */
function targetsFromObjects(
	rows: TargetObjectRow[],
	legacy: LoopTarget[] | null,
): LoopTarget[] | null {
	const cleaned: LoopTarget[] = []
	for (const row of rows) {
		const meta = (row.metadata as Record<string, unknown> | null) ?? {}
		const old = legacy?.find((l) => l.label === row.title)
		const parsed = loopTargetSchema.safeParse({
			label: row.title,
			source: meta.source,
			actual: typeof meta.actual === 'number' ? meta.actual : old?.actual,
			target: meta.target,
			ownerActorId: row.driver ?? undefined,
			pace_policy: old?.pace_policy,
		})
		if (parsed.success) cleaned.push(parsed.data)
	}
	return cleaned.length > 0 ? cleaned : null
}

/**
 * Everything the loop reads need to decide "is this member closed", for a set of loops:
 * the per-type closed statuses, the `closed_when` rules, and the SQL predicate over the
 * `r` (edge) and `o` (member) aliases. One builder so the loops list and the flow-page
 * reads cannot disagree on what closed means.
 */
function buildClosedRules(loopRows: Array<{ id: string; metadata: unknown }>) {
	const closedStatusOverridesByLoop = new Map<string, Record<string, string[]>>()
	const closedWhenByLoop = new Map<string, Record<string, ClosedWhenRule[]>>()
	for (const l of loopRows) {
		const meta = (l.metadata as Record<string, unknown> | null) ?? {}
		const override = readClosedStatuses(meta)
		if (override) closedStatusOverridesByLoop.set(l.id, override)
		const closedWhen = readClosedWhen(meta)
		if (closedWhen) closedWhenByLoop.set(l.id, closedWhen)
	}

	const closedStatusesFor = (loopId: string, type: string): string[] =>
		closedStatusOverridesByLoop.get(loopId)?.[type] ?? TERMINAL_STATUSES_BY_TYPE[type] ?? []
	const isClosedByStatus = (loopId: string, type: string, status: string): boolean =>
		closedStatusesFor(loopId, type).includes(status)

	// "Is this member closed" as one SQL predicate over the `r` (edge) and `o`
	// (member) aliases, built from each loop's own closed_statuses / closed_when
	// (falling back to TERMINAL_STATUSES_BY_TYPE). Both the grouped count and
	// the closed-member read below use it, so they cannot disagree. Statuses and
	// rule values are bound parameters; rule field names are already restricted
	// to SAFE_METADATA_FIELD_NAME_RE by readClosedWhen. A rule matches like
	// matchesClosedWhen: the metadata value is that exact string.
	const closedTerms: ReturnType<typeof sql>[] = []
	for (const l of loopRows) {
		const types = new Set([
			...Object.keys(TERMINAL_STATUSES_BY_TYPE),
			...Object.keys(closedStatusOverridesByLoop.get(l.id) ?? {}),
			...Object.keys(closedWhenByLoop.get(l.id) ?? {}),
		])
		for (const type of types) {
			const conditions: ReturnType<typeof sql>[] = []
			const statuses = closedStatusesFor(l.id, type)
			if (statuses.length > 0) {
				conditions.push(
					sql`o.status IN (${sql.join(
						statuses.map((st) => sql`${st}`),
						sql`, `,
					)})`,
				)
			}
			for (const rule of closedWhenByLoop.get(l.id)?.[type] ?? []) {
				conditions.push(sql`o.metadata -> ${rule.field}::text = to_jsonb(${rule.value}::text)`)
			}
			if (conditions.length === 0) continue
			closedTerms.push(
				sql`(r.source_id = ${l.id}::uuid AND o.type = ${type} AND (${sql.join(conditions, sql` OR `)}))`,
			)
		}
	}
	const isClosedSql =
		closedTerms.length > 0 ? sql`(${sql.join(closedTerms, sql` OR `)})` : sql`false`

	return { closedStatusesFor, isClosedByStatus, closedWhenByLoop, isClosedSql }
}

const listLoopsQuerySchema = z.object({
	id: z.string().uuid().optional().openapi({
		description:
			'Scope the result to a single loop id (used by get_loop). Omit to list every loop in the workspace.',
	}),
})

const listLoopsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['loops'],
	summary: 'List loops in workspace with derived stats',
	description:
		'Returns every Loop object in the workspace with per-row derived fields (in-progress / closed counts, median close time, agent-actor ids, per-viewer waiting flag) computed from a single request. Returns an empty array — not an error — for workspaces with zero loops. Pass `id` to scope to a single loop (still returns `{loops: [...]}`, empty array if that id is not a loop in this workspace).',
	request: {
		headers: workspaceIdHeader,
		query: listLoopsQuerySchema,
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
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('query')

	// Load every Loop in the workspace, or just one when `id` is passed (used
	// by get_loop) — the derived-stats logic below is unaware of the
	// difference, it just fans out over whatever rows come back.
	const loopRows = await db
		.select()
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'loop'),
				...(id ? [eq(objects.id, id)] : []),
			),
		)
	if (loopRows.length === 0) {
		return c.json({ loops: [] })
	}

	const loopIds = loopRows.map((l) => l.id)

	// Target objects linked to these loops (source = target object, target =
	// loop). Oldest link first, so the list keeps a steady order.
	const targetObjectRows = await db
		.select({
			loopId: relationships.targetId,
			title: objects.title,
			driver: objects.driver,
			metadata: objects.metadata,
		})
		.from(relationships)
		.innerJoin(objects, eq(objects.id, relationships.sourceId))
		.where(
			and(
				eq(relationships.type, TARGET_OF_RELATIONSHIP_TYPE),
				inArray(relationships.targetId, loopIds),
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, TARGET_TYPE),
				notInArray(objects.status, HIDDEN_TARGET_STATUSES),
			),
		)
		.orderBy(asc(relationships.createdAt), asc(objects.createdAt))
	const targetObjectsByLoop = new Map<string, TargetObjectRow[]>()
	for (const row of targetObjectRows) {
		const list = targetObjectsByLoop.get(row.loopId) ?? []
		list.push(row)
		targetObjectsByLoop.set(row.loopId, list)
	}

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

	const { closedStatusesFor, isClosedByStatus, closedWhenByLoop, isClosedSql } =
		buildClosedRules(loopRows)

	// Counts come from one grouped query: members bucketed by loop, closed or not,
	// never one row per member. Loops can hold thousands of members.
	const countRows = await db.execute<{ loop_id: string; is_closed: boolean; n: number | string }>(
		sql`
			SELECT r.source_id AS loop_id, ${isClosedSql} AS is_closed, count(*) AS n
			FROM ${relationships} r
			JOIN ${objects} o ON o.id = r.target_id
			WHERE r.type = ${LOOP_MEMBERSHIP_RELATIONSHIP_TYPE}
				AND r.source_id = ANY(${loopIdArray})
				AND o.workspace_id = ${workspaceId}
			GROUP BY r.source_id, is_closed
		`,
	)

	// Only closed members are read per row, and only the columns the close time
	// needs: the median is the middle of per-member durations, which a count
	// cannot give. In-progress members are never fetched. The clock starts when
	// the member joined the loop (the in_loop edge), not when the object was
	// created: an object can exist long before it enters a loop.
	const childRows = await db.execute<{
		loop_id: string
		id: string
		type: string
		status: string
		joined_at: string | Date
		updated_at: string | Date
	}>(
		sql`
			SELECT r.source_id AS loop_id, o.id, o.type, o.status,
				COALESCE(r.created_at, o.created_at) AS joined_at, o.updated_at
			FROM ${relationships} r
			JOIN ${objects} o ON o.id = r.target_id
			WHERE r.type = ${LOOP_MEMBERSHIP_RELATIONSHIP_TYPE}
				AND r.source_id = ANY(${loopIdArray})
				AND o.workspace_id = ${workspaceId}
				AND ${isClosedSql}
		`,
	)

	// A member closed only by a `closed_when` rule (a metadata edit, so no status
	// change) has no close time on its row: updated_at moves on every later edit.
	// Its update events carry the old and new metadata, so the close time is the
	// last event that moved it into a matching state.
	const stageClosedIds = Array.from(
		new Set(
			childRows
				.filter((row) => !isClosedByStatus(row.loop_id, row.type, row.status))
				.map((row) => row.id),
		),
	)
	const stageEventsByObject = new Map<string, Array<{ createdAt: Date | null; data: unknown }>>()
	if (stageClosedIds.length > 0) {
		const stageEvents = await fetchEventsForObjects(db, workspaceId, stageClosedIds, [
			'updated',
			'status_changed',
		])
		for (const ev of stageEvents) {
			const list = stageEventsByObject.get(ev.entityId) ?? []
			list.push({ createdAt: ev.createdAt, data: ev.data })
			stageEventsByObject.set(ev.entityId, list)
		}
	}
	const stageClosedAt = (row: { loop_id: string; id: string; type: string }): Date | null => {
		const rules = closedWhenByLoop.get(row.loop_id)?.[row.type] ?? []
		let closedAt: Date | null = null
		for (const ev of stageEventsByObject.get(row.id) ?? []) {
			const change = findChange(readChanges(ev.data), 'metadata')
			if (!change || !ev.createdAt) continue
			if (!matchesClosedWhen(rules, change.old) && matchesClosedWhen(rules, change.new)) {
				closedAt = ev.createdAt
			}
		}
		return closedAt
	}

	// A closed member keeps its in_loop edge, so its close time comes from the
	// first status-change event that moved it into the loop's closed set, not
	// from updated_at (any later edit moves that). One batched query for every
	// status-closed member across all loops in the request, never one per member;
	// no closed members, no query.
	const closedObjectIds = Array.from(
		new Set(
			childRows
				.filter((row) => isClosedByStatus(row.loop_id, row.type, row.status))
				.map((row) => row.id),
		),
	)
	const statusEventsByObject = new Map<string, Array<{ status: unknown; at: Date }>>()
	if (closedObjectIds.length > 0) {
		const statusEventRows = await fetchEventsForObjects(db, workspaceId, closedObjectIds, [
			'status_changed',
		])
		for (const ev of statusEventRows) {
			if (!ev.createdAt) continue
			const status = findChange(getChangesFromEventData(ev.data, ['status']), 'status')?.new
			if (status === undefined) continue
			const list = statusEventsByObject.get(ev.entityId) ?? []
			list.push({ status, at: ev.createdAt })
			statusEventsByObject.set(ev.entityId, list)
		}
	}

	// Close time for a member closed by status: the first event that moved it
	// into the closed set, falling back to updated_at when it has none (closed
	// before events carried a diff, or the status was set directly).
	const statusClosedAtMs = (row: (typeof childRows)[number]): number => {
		const terminal = closedStatusesFor(row.loop_id, row.type)
		const moved = statusEventsByObject
			.get(row.id)
			?.find((ev) => typeof ev.status === 'string' && terminal.includes(ev.status))
		return (moved?.at ?? new Date(row.updated_at)).getTime()
	}

	const childStatsByLoop = new Map<
		string,
		{ inProgressCount: number; closedCount: number; medianCloseMs: number | null }
	>()
	{
		for (const row of countRows) {
			const stats = childStatsByLoop.get(row.loop_id) ?? {
				inProgressCount: 0,
				closedCount: 0,
				medianCloseMs: null,
			}
			if (row.is_closed) stats.closedCount += Number(row.n)
			else stats.inProgressCount += Number(row.n)
			childStatsByLoop.set(row.loop_id, stats)
		}
		const closeDurationsByLoop = new Map<string, number[]>()
		for (const row of childRows) {
			const closedAtMs = isClosedByStatus(row.loop_id, row.type, row.status)
				? statusClosedAtMs(row)
				: (stageClosedAt(row)?.getTime() ?? new Date(row.updated_at).getTime())
			// Closed before it joined the loop: it never went through this loop, so
			// it has no time to close and stays out of the median.
			const durationMs = closedAtMs - new Date(row.joined_at).getTime()
			if (durationMs < 0) continue
			const durations = closeDurationsByLoop.get(row.loop_id) ?? []
			durations.push(durationMs)
			closeDurationsByLoop.set(row.loop_id, durations)
		}
		// Median matches percentile_cont(0.5): linear interpolation — for an
		// even count, the mean of the two middle values.
		for (const [loopId, durations] of closeDurationsByLoop) {
			durations.sort((a, b) => a - b)
			const mid = Math.floor(durations.length / 2)
			const median =
				durations.length % 2 === 1
					? (durations[mid] as number)
					: ((durations[mid - 1] as number) + (durations[mid] as number)) / 2
			const stats = childStatsByLoop.get(loopId)
			if (stats) stats.medianCloseMs = Math.max(0, Math.round(median))
		}
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

	// "Waiting on you" flag + count. Same predicate the D3 `AskBanner` uses on
	// the loop-detail page (`GET /:id/steps` further down this file, and
	// `packages/shared/src/loops/waiting-on-viewer.ts`): a step is waiting
	// when at least one session on that step's trigger sits in
	// `status = 'waiting_for_input'`. Unifying to one predicate here means the
	// loops-list `waiting_on_you` pill, the loops-list `waitingCount`, the
	// loop-detail `Asks waiting` tile, and the AskBanner all count exactly
	// the thing the user thinks they count — an agent step blocked awaiting
	// their input. Previously this was "any unread event on any child
	// object", which mixed status-change notifications into the "waiting on
	// me" signal and let the banner fire while the tile still read 0.
	const pendingByTrigger = new Map<string, number>()
	if (allTriggerIds.length > 0) {
		const pendingRows = await db
			.select({ triggerId: sessions.triggerId, count: sql<number>`COUNT(*)::int` })
			.from(sessions)
			.where(
				and(
					eq(sessions.workspaceId, workspaceId),
					inArray(sessions.triggerId, allTriggerIds),
					eq(sessions.status, 'waiting_for_input'),
				),
			)
			.groupBy(sessions.triggerId)
		for (const row of pendingRows) {
			if (row.triggerId) pendingByTrigger.set(row.triggerId, row.count)
		}
	}
	const waitingByLoop = new Map<string, boolean>()
	const waitingCountByLoop = new Map<string, number>()
	for (const { loopId, triggerIds: perLoopTriggerIds } of perLoopTriggers) {
		let count = 0
		for (const tid of perLoopTriggerIds) {
			count += pendingByTrigger.get(tid) ?? 0
		}
		waitingCountByLoop.set(loopId, count)
		waitingByLoop.set(loopId, count > 0)
	}

	const LIVE_STATUSES = new Set(['learning', 'supervised', 'fully_autonomous'])

	const response = {
		loops: loopRows.map((row) => {
			const rawStatus = row.status
			const status = ((): 'draft' | 'paused' | 'learning' | 'supervised' | 'fully_autonomous' => {
				if (
					rawStatus === 'draft' ||
					rawStatus === 'paused' ||
					rawStatus === 'learning' ||
					rawStatus === 'supervised' ||
					rawStatus === 'fully_autonomous'
				) {
					return rawStatus
				}
				// Unknown status (shouldn't happen with schema-validated statuses,
				// but preserved so a manual UPDATE cannot 500 the endpoint).
				return 'draft'
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
			// Target objects first; the rows in metadata.targets stay as the
			// fallback for a flow with no target objects yet.
			const legacyTargets = readLoopTargets(meta)
			const targets =
				targetsFromObjects(targetObjectsByLoop.get(row.id) ?? [], legacyTargets) ?? legacyTargets
			const tags = normalizeTags(meta.tags)

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
			const waitingCount = waitingCountByLoop.get(row.id) ?? 0

			// Composite pill signal. `draft`/`paused` are not "live" — they render
			// as themselves regardless of read state. The three live statuses
			// (learning/supervised/fully_autonomous) compose with waitingOnViewer:
			// unread activity on a member object overrides the autonomy-stage
			// label with the amber "waiting on you" pill.
			const pill:
				| 'draft'
				| 'paused'
				| 'learning'
				| 'supervised'
				| 'fully_autonomous'
				| 'waiting_on_you' =
				LIVE_STATUSES.has(status) && waitingOnViewer ? 'waiting_on_you' : status

			return {
				id: row.id,
				workspaceId: row.workspaceId,
				name: row.title,
				content: row.content,
				status,
				pill,
				entryCondition,
				closeCondition,
				tags,
				driverId: row.driver,
				inProgressCount: stats.inProgressCount,
				closedCount: stats.closedCount,
				medianTimeToCloseMs: stats.medianCloseMs,
				agentIds,
				triggerIds,
				waitingOnViewer,
				waitingCount,
				targets,
				createdAt: row.createdAt ? row.createdAt.toISOString() : null,
				updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
			}
		}),
	}

	return c.json(response)
}) as RouteHandler<typeof listLoopsRoute, Env>)

/**
 * `GET /api/loops/:id/activity` — the "Latest activity" feed on the loop detail
 * screen. Distinct from `/api/events/history?entity_id=<loopId>` (which is
 * scoped to the loop row itself and drives the Changes log): session and
 * trigger events carry `entityId = session.id` / `trigger.id`, so filtering by
 * loop id alone cannot reach them. This endpoint reaches them by joining
 * through the loop's `metadata.trigger_ids`:
 *   - `trigger_fired` events for those trigger ids
 *   - `session_*` lifecycle events for sessions whose `triggerId` is in that
 *     list (session-manager writes these under `entityType = 'session'`).
 * Result: the feed shows what the agents actually did on the loop, without any
 * overlap with the loop-row events the Changes log renders.
 */
const loopActivityRoute = createRoute({
	method: 'get',
	path: '/{id}/activity',
	tags: ['loops'],
	summary: "Agent-work events (session + trigger) scoped to a loop's triggers",
	description:
		"Returns the loop's agent-work event feed: `trigger_fired` events for the trigger ids listed in the loop's `metadata.trigger_ids`, plus `session_*` lifecycle events for sessions launched from those triggers. Newest first. Returns `{ events: [] }` — not an error — for a loop with no triggers, no fired triggers, or an unknown id (a foreign loop returns empty without leaking existence).",
	request: {
		headers: workspaceIdHeader,
		params: z.object({ id: z.string().uuid() }),
	},
	responses: {
		200: {
			description: 'Agent-work events for this loop, newest first',
			content: {
				'application/json': { schema: z.object({ events: z.array(eventResponseSchema) }) },
			},
		},
		400: {
			description: 'Missing workspace ID or malformed loop id',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(loopActivityRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id: loopId } = c.req.valid('param')

	const [loop] = await db
		.select({ metadata: objects.metadata })
		.from(objects)
		.where(
			and(eq(objects.id, loopId), eq(objects.workspaceId, workspaceId), eq(objects.type, 'loop')),
		)
		.limit(1)

	if (!loop) {
		return c.json({ events: [] })
	}

	const meta = (loop.metadata as Record<string, unknown> | null) ?? {}
	const raw = meta.trigger_ids
	const triggerIds = Array.isArray(raw)
		? raw.filter((v): v is string => typeof v === 'string' && UUID_RE.test(v))
		: []

	if (triggerIds.length === 0) {
		return c.json({ events: [] })
	}

	// Sessions launched from any of the loop's triggers. `triggerId` is
	// nullable and set to NULL on trigger delete, so a stale metadata.trigger_ids
	// entry naturally drops out here — no join to the triggers table needed.
	const loopSessions = await db
		.select({ id: sessions.id })
		.from(sessions)
		.where(and(eq(sessions.workspaceId, workspaceId), inArray(sessions.triggerId, triggerIds)))
	const sessionIds = loopSessions.map((s) => s.id)

	// `trigger_fired` events are keyed to the trigger; `session_*` events are
	// keyed to the session. Both are filtered to this workspace so a leaked
	// id in metadata cannot pull events from another workspace.
	const sessionActions = [
		'session_created',
		'session_running',
		'session_completed',
		'session_failed',
		'session_timeout',
		'session_stopped',
		'session_paused',
	]

	const conditions = [
		and(
			eq(events.action, 'trigger_fired'),
			eq(events.entityType, 'trigger'),
			inArray(events.entityId, triggerIds),
		),
	]
	if (sessionIds.length > 0) {
		conditions.push(
			and(
				inArray(events.action, sessionActions),
				eq(events.entityType, 'session'),
				inArray(events.entityId, sessionIds),
			),
		)
	}

	const rows = await db
		.select()
		.from(events)
		.where(and(eq(events.workspaceId, workspaceId), or(...conditions)))
		.orderBy(desc(events.createdAt))
		.limit(50)

	return c.json({
		events: serializeArray(rows) as z.infer<typeof eventResponseSchema>[],
	})
}) as RouteHandler<typeof loopActivityRoute, Env>)

/**
 * `GET /api/loops/:id/steps` — the loop-detail vertical-story renderer's data
 * feed (Loops v4 / D6c). Returns one `LoopStep` per trigger id in
 * `metadata.trigger_ids`, preserved in that order (a spine, not a set). Each
 * step carries the three Loops v4 fields the renderer keys off
 * (`handsOffToActorId`, `escalatesToActorId`, `escalateAfterMs`) plus resolved
 * actor names for the hands-off / escalation targets so the frontend doesn't
 * need a second lookup, and a per-viewer `waitingOnViewer` + `pendingCount`
 * derived from sessions currently in `waiting_for_input` for that trigger.
 *
 * Returns `{ steps: [] }` — not 404 — for a loop with no triggers or an
 * unknown id, mirroring `/api/loops` and `/api/loops/:id/activity` so a
 * foreign / deleted id doesn't leak existence.
 *
 * This is a read-only endpoint. Step CRUD lives on the composer path
 * (POST/PATCH /api/triggers, POST/DELETE /api/relationships) — D6 is a READ
 * rewrite (see SPEC rabbit hole).
 */
const loopStepsRoute = createRoute({
	method: 'get',
	path: '/{id}/steps',
	tags: ['loops'],
	summary: 'Vertical-story step spine for one loop',
	description:
		"Returns the loop's ordered step spine — one row per trigger id in `metadata.trigger_ids`, with hands-off / escalates fields and per-viewer waiting-on-viewer counts pre-resolved so the vertical-story renderer can spread it as-is. Empty array for a loop with no triggers or an unknown id.",
	request: {
		headers: workspaceIdHeader,
		params: z.object({ id: z.string().uuid() }),
	},
	responses: {
		200: {
			description: 'Ordered LoopStep spine (may be empty)',
			content: { 'application/json': { schema: listLoopStepsResponseSchema } },
		},
		400: {
			description: 'Missing workspace ID or malformed loop id',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(loopStepsRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id: loopId } = c.req.valid('param')

	const [loop] = await db
		.select({ metadata: objects.metadata })
		.from(objects)
		.where(
			and(eq(objects.id, loopId), eq(objects.workspaceId, workspaceId), eq(objects.type, 'loop')),
		)
		.limit(1)

	if (!loop) {
		return c.json({ steps: [] })
	}

	const meta = (loop.metadata as Record<string, unknown> | null) ?? {}
	const raw = meta.trigger_ids
	const orderedTriggerIds = Array.isArray(raw)
		? raw.filter((v): v is string => typeof v === 'string' && UUID_RE.test(v))
		: []

	if (orderedTriggerIds.length === 0) {
		return c.json({ steps: [] })
	}

	// Load every trigger referenced by the loop. Foreign / deleted ids drop
	// out silently, same tolerance as `/api/loops`.
	const triggerRows = await db
		.select({
			id: triggers.id,
			name: triggers.name,
			type: triggers.type,
			actionPrompt: triggers.actionPrompt,
			config: triggers.config,
			targetActorId: triggers.targetActorId,
			handsOffToActorId: triggers.handsOffToActorId,
			escalatesToActorId: triggers.escalatesToActorId,
			escalateAfterMs: triggers.escalateAfterMs,
		})
		.from(triggers)
		.where(and(eq(triggers.workspaceId, workspaceId), inArray(triggers.id, orderedTriggerIds)))

	const triggerById = new Map(triggerRows.map((t) => [t.id, t]))

	// One batched actor lookup for the three per-step actor refs (target /
	// hands-off / escalates). Missing ids, and ids of actors who are not members
	// of this workspace, just resolve to null on the step.
	const actorIds = new Set<string>()
	for (const t of triggerRows) {
		if (t.targetActorId) actorIds.add(t.targetActorId)
		if (t.handsOffToActorId) actorIds.add(t.handsOffToActorId)
		if (t.escalatesToActorId) actorIds.add(t.escalatesToActorId)
	}
	const actorRows =
		actorIds.size > 0
			? await db
					.select({ id: actors.id, name: actors.name, description: actors.description })
					.from(actors)
					.innerJoin(
						workspaceMembers,
						and(
							eq(workspaceMembers.actorId, actors.id),
							eq(workspaceMembers.workspaceId, workspaceId),
						),
					)
					.where(inArray(actors.id, Array.from(actorIds)))
			: []
	const actorById = new Map(actorRows.map((a) => [a.id, a]))

	// Per-step waitingOnViewer + pendingCount derived from sessions currently
	// in `waiting_for_input` for the trigger. Same shape T1's shared predicate
	// will formalise (`packages/shared/src/loops/waiting-on-viewer.ts`) — kept
	// inlined here for D6c so this task doesn't wait on T1 landing; the two
	// can consolidate later when the shared helper module ships.
	const pendingRows =
		orderedTriggerIds.length > 0
			? await db
					.select({ triggerId: sessions.triggerId, count: sql<number>`COUNT(*)::int` })
					.from(sessions)
					.where(
						and(
							eq(sessions.workspaceId, workspaceId),
							inArray(sessions.triggerId, orderedTriggerIds),
							eq(sessions.status, 'waiting_for_input'),
						),
					)
					.groupBy(sessions.triggerId)
			: []
	const pendingByTrigger = new Map<string, number>()
	for (const r of pendingRows) {
		if (r.triggerId) pendingByTrigger.set(r.triggerId, r.count)
	}

	const steps = orderedTriggerIds
		.map((triggerId) => {
			const t = triggerById.get(triggerId)
			if (!t) return null
			const agent = t.targetActorId ? (actorById.get(t.targetActorId) ?? null) : null
			const handsOffToActor = t.handsOffToActorId
				? (actorById.get(t.handsOffToActorId) ?? null)
				: null
			const escalatesToActor = t.escalatesToActorId
				? (actorById.get(t.escalatesToActorId) ?? null)
				: null
			const pendingCount = pendingByTrigger.get(t.id) ?? 0
			return {
				triggerId: t.id,
				triggerName: t.name,
				triggerActionPrompt: t.actionPrompt,
				triggerType: t.type,
				triggerConfig: (t.config as Record<string, unknown> | null) ?? undefined,
				agent,
				handsOffToActorId: t.handsOffToActorId,
				escalatesToActorId: t.escalatesToActorId,
				escalateAfterMs: t.escalateAfterMs,
				handsOffToActor,
				escalatesToActor,
				waitingOnViewer: pendingCount > 0,
				pendingCount,
			}
		})
		.filter((s): s is NonNullable<typeof s> => s !== null)

	return c.json({ steps })
}) as RouteHandler<typeof loopStepsRoute, Env>)

/** Open members the Next steps tile lists; the full open count is `inProgressCount`. */
const NEXT_STEP_ITEM_LIMIT = 10

/** Briefing pages the Briefings tile lists. Matches the For you row. */
const FLOW_BRIEFING_LIMIT = 24

/**
 * `GET /api/loops/:id/next-steps` — the flow page's Next steps tile, derived on read from
 * what the flow already has, nothing stored. First the asks: steps with sessions in
 * `waiting_for_input` (the same predicate as `/steps`, the list's `waitingCount` and the
 * ask banner), most waiting first. Then the newest open members, using the flow's own
 * closed rules so "open" matches `inProgressCount`.
 */
const loopNextStepsRoute = createRoute({
	method: 'get',
	path: '/{id}/next-steps',
	tags: ['loops'],
	summary: 'Next steps for one loop: asks waiting first, then open members',
	description:
		'Returns `asks` (steps with sessions waiting on a person, most waiting first) and `items` (the newest open members of the loop, capped at 10). Both are empty for a loop with nothing to do, no steps, or an unknown id (a foreign loop returns empty without leaking existence).',
	request: {
		headers: workspaceIdHeader,
		params: z.object({ id: z.string().uuid() }),
	},
	responses: {
		200: {
			description: 'Next steps (may be empty)',
			content: { 'application/json': { schema: loopNextStepsResponseSchema } },
		},
		400: {
			description: 'Missing workspace ID or malformed loop id',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(loopNextStepsRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id: loopId } = c.req.valid('param')

	const [loop] = await db
		.select({ id: objects.id, metadata: objects.metadata })
		.from(objects)
		.where(
			and(eq(objects.id, loopId), eq(objects.workspaceId, workspaceId), eq(objects.type, 'loop')),
		)
		.limit(1)
	if (!loop) return c.json({ asks: [], items: [] })

	const meta = (loop.metadata as Record<string, unknown> | null) ?? {}
	const raw = meta.trigger_ids
	const triggerIds = Array.isArray(raw)
		? raw.filter((v): v is string => typeof v === 'string' && UUID_RE.test(v))
		: []

	// Asks: steps with sessions waiting on a person.
	const pendingRows =
		triggerIds.length > 0
			? await db
					.select({ triggerId: sessions.triggerId, count: sql<number>`COUNT(*)::int` })
					.from(sessions)
					.where(
						and(
							eq(sessions.workspaceId, workspaceId),
							inArray(sessions.triggerId, triggerIds),
							eq(sessions.status, 'waiting_for_input'),
						),
					)
					.groupBy(sessions.triggerId)
			: []
	const pendingByTrigger = new Map<string, number>()
	for (const r of pendingRows) {
		if (r.triggerId && r.count > 0) pendingByTrigger.set(r.triggerId, r.count)
	}

	let asks: Array<{
		triggerId: string
		triggerName: string | null
		agent: { id: string; name: string | null; description: string | null } | null
		pendingCount: number
	}> = []
	if (pendingByTrigger.size > 0) {
		const triggerRows = await db
			.select({ id: triggers.id, name: triggers.name, targetActorId: triggers.targetActorId })
			.from(triggers)
			.where(
				and(
					eq(triggers.workspaceId, workspaceId),
					inArray(triggers.id, [...pendingByTrigger.keys()]),
				),
			)
		const triggerById = new Map(triggerRows.map((t) => [t.id, t]))
		const agentIds = triggerRows.flatMap((t) => (t.targetActorId ? [t.targetActorId] : []))
		const agentRows =
			agentIds.length > 0
				? await db
						.select({ id: actors.id, name: actors.name, description: actors.description })
						.from(actors)
						.innerJoin(
							workspaceMembers,
							and(
								eq(workspaceMembers.actorId, actors.id),
								eq(workspaceMembers.workspaceId, workspaceId),
							),
						)
						.where(inArray(actors.id, agentIds))
				: []
		const agentById = new Map(agentRows.map((a) => [a.id, a]))
		// Spine order breaks ties between steps with the same number waiting.
		asks = triggerIds
			.flatMap((id, position) => {
				const trigger = triggerById.get(id)
				const pendingCount = pendingByTrigger.get(id)
				if (!trigger || !pendingCount) return []
				return [
					{
						position,
						triggerId: id,
						triggerName: trigger.name,
						agent: trigger.targetActorId ? (agentById.get(trigger.targetActorId) ?? null) : null,
						pendingCount,
					},
				]
			})
			.sort((a, b) => b.pendingCount - a.pendingCount || a.position - b.position)
			.map(({ position: _position, ...ask }) => ask)
	}

	// Items: the newest open members. A NULL from a `closed_when` rule on a member without
	// that field counts as open, the same way the grouped count in the list buckets it.
	const { isClosedSql } = buildClosedRules([loop])
	const openRows = await db.execute<{
		id: string
		type: string
		title: string | null
		status: string
	}>(
		sql`
			SELECT o.id, o.type, o.title, o.status
			FROM ${relationships} r
			JOIN ${objects} o ON o.id = r.target_id
			WHERE r.type = ${LOOP_MEMBERSHIP_RELATIONSHIP_TYPE}
				AND r.source_id = ${loopId}::uuid
				AND o.workspace_id = ${workspaceId}
				AND ${isClosedSql} IS NOT TRUE
			ORDER BY o.updated_at DESC, o.id
			LIMIT ${NEXT_STEP_ITEM_LIMIT}
		`,
	)
	const items = openRows.map((row) => ({
		id: row.id,
		type: row.type,
		title: row.title,
		status: row.status,
	}))

	return c.json({ asks, items })
}) as RouteHandler<typeof loopNextStepsRoute, Env>)

/**
 * `GET /api/loops/:id/briefings` — the flow page's Briefings tile. A briefing is a file of
 * kind `briefing` (the same marker For you reads), linked to a flow by an `attached` edge
 * from the flow itself or from one of its members (`in_loop`), which is how an agent
 * publishes what a flow produced. One query, newest first, each page once. When a page is
 * attached to both the flow and a member, the flow wins as its source.
 */
const loopBriefingsRoute = createRoute({
	method: 'get',
	path: '/{id}/briefings',
	tags: ['loops'],
	summary: 'Briefing pages attached to one loop or its members',
	description:
		'Returns the loop\'s briefing pages (files of kind "briefing" attached to the loop or to one of its members), newest first, each page once, capped at 24. Empty for a loop with none or an unknown id (a foreign loop returns empty without leaking existence).',
	request: {
		headers: workspaceIdHeader,
		params: z.object({ id: z.string().uuid() }),
	},
	responses: {
		200: {
			description: 'Briefing pages (may be empty)',
			content: { 'application/json': { schema: listLoopBriefingsResponseSchema } },
		},
		400: {
			description: 'Missing workspace ID or malformed loop id',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(loopBriefingsRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id: loopId } = c.req.valid('param')

	const [loop] = await db
		.select({ id: objects.id })
		.from(objects)
		.where(
			and(eq(objects.id, loopId), eq(objects.workspaceId, workspaceId), eq(objects.type, 'loop')),
		)
		.limit(1)
	if (!loop) return c.json({ briefings: [] })

	const rows = await db.execute<{
		id: string
		name: string
		mime_type: string
		updated_at: string | Date
		source_id: string
		source_title: string | null
	}>(
		sql`
			SELECT * FROM (
				SELECT DISTINCT ON (f.id)
					f.id, f.name, f.mime_type, f.updated_at,
					o.id AS source_id, o.title AS source_title
				FROM ${files} f
				JOIN ${relationships} r
					ON r.target_id = f.id
					AND r.target_type = 'file'
					AND r.source_type = 'object'
					AND r.type = 'attached'
				JOIN ${objects} o ON o.id = r.source_id AND o.workspace_id = ${workspaceId}
				WHERE f.workspace_id = ${workspaceId}
					AND f.kind = 'briefing'
					AND (
						r.source_id = ${loopId}::uuid
						OR r.source_id IN (
							SELECT m.target_id FROM ${relationships} m
							WHERE m.type = ${LOOP_MEMBERSHIP_RELATIONSHIP_TYPE}
								AND m.source_id = ${loopId}::uuid
						)
					)
				ORDER BY f.id, (r.source_id = ${loopId}::uuid) DESC, r.created_at
			) pages
			ORDER BY updated_at DESC, id
			LIMIT ${FLOW_BRIEFING_LIMIT}
		`,
	)

	return c.json({
		briefings: rows.map((row) => ({
			id: row.id,
			name: row.name,
			mimeType: row.mime_type,
			updatedAt: new Date(row.updated_at).toISOString(),
			sourceId: row.source_id,
			sourceTitle: row.source_title,
		})),
	})
}) as RouteHandler<typeof loopBriefingsRoute, Env>)

export default app
