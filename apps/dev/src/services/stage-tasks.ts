/**
 * stage-tasks.ts — creates a flow stage's standard tasks when an object enters the stage (bet
 * "Flows that run like development", task "Add a task list per stage").
 *
 * An object enters a stage when it is moved to a status, or when it is added to a flow
 * (`in_loop` edge) while already in one. For each running flow the object is a member of, the
 * flow's `metadata.stage_tasks["<type>:<status>"]` lists the tasks (see lib/stage-tasks.ts). Each
 * becomes a task under the object (`breaks_into`) with its owner as driver, a due date in
 * `metadata.due_at` and the done test as the "Done when" line of its body.
 *
 * A task that is ready now (no due date, or due within 24 hours) is created at todo, so its owner
 * starts on the task wake. A later one is created at backlog and the sweep wakes its owner when it
 * gets close.
 *
 * Moving an object to a status still fires the flow's stage triggers; this runs beside them.
 * A flow with no list for the stage does nothing. Every server instance sees the same event, so
 * each entry is claimed under an advisory lock and a key on the tasks it created: the second
 * instance finds the first one's tasks and stops.
 */
import type { Database, Transaction } from '@maskin/db'
import { events, actors, objects, relationships, workspaceMembers } from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { LIVE_FLOW_STATUSES, readChanges } from '@maskin/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { type StageTaskSpec, readStageTasks, stageTaskContent } from '../lib/stage-tasks'

/** A task due within this long is ready now, as in the sweep. */
const READY_WITHIN_MS = 24 * 60 * 60_000

export interface StageEntry {
	workspaceId: string
	objectId: string
	/** The status the object entered. */
	status: string
	/** Who moved it. The created tasks are theirs. */
	actorId: string
	/** The event that moved it. With the flow it keys the entry, so a replayed event adds nothing. */
	eventId: string
	now: Date
	/** Only this flow, when the entry is the object being added to it. */
	onlyLoopId?: string
}

/** Whether a created task is ready for its owner now or waits for its due date. */
export function stageTaskStatus(dueAt: Date | null, now: Date): 'todo' | 'backlog' {
	if (!dueAt) return 'todo'
	return dueAt.getTime() - now.getTime() <= READY_WITHIN_MS ? 'todo' : 'backlog'
}

async function resolveOwner(
	tx: Transaction,
	workspaceId: string,
	name: string,
): Promise<string | null> {
	if (!name) return null
	const [actor] = await tx
		.select({ id: actors.id })
		.from(actors)
		.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				sql`lower(${actors.name}) = ${name.toLowerCase()}`,
			),
		)
		.limit(1)
	return actor?.id ?? null
}

/** Creates the standard tasks for one object entering one stage. Returns how many it made. */
export async function createStageTasks(db: Database, entry: StageEntry): Promise<number> {
	const [member] = await db
		.select({ id: objects.id, type: objects.type, title: objects.title })
		.from(objects)
		.where(and(eq(objects.id, entry.objectId), eq(objects.workspaceId, entry.workspaceId)))
		.limit(1)
	if (!member) return 0

	const loops = await db
		.select({
			id: objects.id,
			title: objects.title,
			driver: objects.driver,
			metadata: objects.metadata,
		})
		.from(relationships)
		.innerJoin(objects, eq(objects.id, relationships.sourceId))
		.where(
			and(
				eq(relationships.type, 'in_loop'),
				eq(relationships.targetId, member.id),
				eq(objects.type, 'loop'),
				eq(objects.workspaceId, entry.workspaceId),
				inArray(objects.status, [...LIVE_FLOW_STATUSES]),
			),
		)

	let made = 0
	for (const loop of loops) {
		if (entry.onlyLoopId && loop.id !== entry.onlyLoopId) continue
		const specs = readStageTasks(loop.metadata, member.type, entry.status)
		if (specs.length === 0) continue
		made += await db.transaction((tx) => createForLoop(tx, entry, member, loop, specs))
	}
	return made
}

async function createForLoop(
	tx: Transaction,
	entry: StageEntry,
	member: { id: string; type: string; title: string | null },
	loop: { id: string; driver: string | null },
	specs: StageTaskSpec[],
): Promise<number> {
	const entryKey = `${entry.eventId}:${loop.id}`
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`stage-tasks:${entryKey}`}))`)
	const [claimed] = await tx
		.select({ id: objects.id })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, entry.workspaceId),
				eq(objects.type, 'task'),
				sql`${objects.metadata}->>'stage_entry' = ${entryKey}`,
			),
		)
		.limit(1)
	if (claimed) return 0

	// An object with no title is named by its type in the task body.
	const parent = { id: member.id, type: member.type, title: member.title ?? member.type }
	let made = 0
	for (const [index, spec] of specs.entries()) {
		const ownerId = (await resolveOwner(tx, entry.workspaceId, spec.owner)) ?? loop.driver
		const dueAt = spec.dueAfterMs === null ? null : new Date(entry.now.getTime() + spec.dueAfterMs)
		const status = stageTaskStatus(dueAt, entry.now)
		const [task] = await tx
			.insert(objects)
			.values({
				workspaceId: entry.workspaceId,
				type: 'task',
				title: spec.title,
				content: stageTaskContent(spec, parent, entry.status, dueAt),
				status,
				driver: ownerId,
				createdBy: entry.actorId,
				metadata: {
					source: 'stage_task',
					stage_entry: entryKey,
					stage_task_index: index,
					stage: entry.status,
					flow_id: loop.id,
					...(dueAt ? { due_at: dueAt.toISOString() } : {}),
					...(spec.doneTest ? { done_test: spec.doneTest } : {}),
				},
			})
			.returning()
		if (!task) continue
		await recordEvent(tx, {
			workspaceId: entry.workspaceId,
			actorId: entry.actorId,
			action: 'created',
			entityType: 'task',
			entityId: task.id,
			data: task,
		})
		const [edge] = await tx
			.insert(relationships)
			.values({
				sourceType: 'object',
				sourceId: member.id,
				targetType: 'object',
				targetId: task.id,
				type: 'breaks_into',
				createdBy: entry.actorId,
			})
			.returning()
		if (edge) {
			await recordEvent(tx, {
				workspaceId: entry.workspaceId,
				actorId: entry.actorId,
				action: 'created',
				entityType: 'relationship',
				entityId: edge.id,
				data: edge,
			})
		}
		made++
	}
	return made
}

/** Listens for status changes and for objects added to a flow, and creates the stage's tasks. */
export class StageTaskCreator {
	private handler: ((event: PgEvent) => void) | null = null

	constructor(
		private db: Database,
		private bridge: PgNotifyBridge,
	) {}

	start(): void {
		if (this.handler) return
		this.handler = (event: PgEvent) => {
			const run =
				event.action === 'status_changed'
					? this.onStatusChanged(event)
					: event.action === 'created' && event.entity_type === 'relationship'
						? this.onAddedToFlow(event)
						: null
			run?.catch((err) =>
				logger.error('Stage task creation failed', {
					eventId: event.event_id,
					error: err instanceof Error ? err.message : String(err),
				}),
			)
		}
		this.bridge.on('event', this.handler)
		logger.info('Stage task creator started')
	}

	stop(): void {
		if (!this.handler) return
		this.bridge.off('event', this.handler)
		this.handler = null
	}

	async onStatusChanged(event: PgEvent): Promise<void> {
		const [row] = await this.db
			.select({ data: events.data })
			.from(events)
			.where(eq(events.id, Number(event.event_id)))
			.limit(1)
		const change = readChanges(row?.data)?.find((c) => c.field === 'status')
		if (!change || typeof change.new !== 'string') return
		await createStageTasks(this.db, {
			workspaceId: event.workspace_id,
			objectId: event.entity_id,
			status: change.new,
			actorId: event.actor_id,
			eventId: event.event_id,
			now: new Date(),
		})
	}

	/** An object added to a flow while already in a stage enters that stage for that flow. */
	async onAddedToFlow(event: PgEvent): Promise<void> {
		const [row] = await this.db
			.select({ data: events.data })
			.from(events)
			.where(eq(events.id, Number(event.event_id)))
			.limit(1)
		const edge = row?.data as { type?: string; sourceId?: string; targetId?: string } | null
		if (edge?.type !== 'in_loop' || !edge.sourceId || !edge.targetId) return
		const [member] = await this.db
			.select({ status: objects.status })
			.from(objects)
			.where(and(eq(objects.id, edge.targetId), eq(objects.workspaceId, event.workspace_id)))
			.limit(1)
		if (!member?.status) return
		await createStageTasks(this.db, {
			workspaceId: event.workspace_id,
			objectId: edge.targetId,
			status: member.status,
			actorId: event.actor_id,
			eventId: event.event_id,
			now: new Date(),
			onlyLoopId: edge.sourceId,
		})
	}
}
