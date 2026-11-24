import type { Database, Transaction } from '@maskin/db'
import { objects, relationships } from '@maskin/db/schema'
import { OBJECT_DIFF_FIELDS, computeChanges } from '@maskin/shared'
import { and, eq, sql } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import type { LoopChecklist } from '../lib/marketplace-loops/loop-settings'

/**
 * Onboarding checklist for a freshly installed marketplace loop. A loop that ships a checklist
 * (see `loopChecklistSchema`) gets one parent task and one child task per prerequisite in the
 * installer's workspace, linked to the parent (`breaks_into`) and to the loop object (`in_loop`).
 * Each task is created at backlog and then moved to todo, so the moves are real status changes
 * that the workspace's task triggers see.
 *
 * Runs once per install, inside the install transaction. It does nothing when the install already
 * has checklist tasks, so a repeat call never duplicates them. Existing installs are not touched:
 * the version pusher does not call this.
 */

type DbHandle = Database | Transaction

export async function provisionLoopChecklist(params: {
	db: DbHandle
	workspaceId: string
	actorId: string
	installId: string
	loopObjectId: string
	checklist: LoopChecklist
	/** Installed agent that drives every task. Null leaves the tasks without a driver. */
	driverActorId: string | null
}): Promise<{ created: number }> {
	const { db, workspaceId, actorId, installId, loopObjectId, checklist, driverActorId } = params

	const [existing] = await db
		.select({ id: objects.id })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'task'),
				sql`${objects.metadata}->>'checklist_install_id' = ${installId}`,
			),
		)
		.limit(1)
	if (existing) return { created: 0 }

	const rows = [
		{ title: checklist.title, content: checklist.body, parent: true },
		...checklist.items.map((item) => ({ title: item.title, content: item.body, parent: false })),
	]

	const created = await db
		.insert(objects)
		.values(
			rows.map((row) => ({
				workspaceId,
				type: 'task',
				title: row.title,
				content: row.content,
				status: 'backlog',
				driver: driverActorId,
				createdBy: actorId,
				metadata: {
					checklist_install_id: installId,
					checklist_role: row.parent ? 'parent' : 'item',
				},
			})),
		)
		.returning()

	for (const task of created) {
		await recordEvent(db, {
			workspaceId,
			actorId,
			action: 'created',
			entityType: 'task',
			entityId: task.id,
			data: task,
		})
	}

	const isParent = (task: (typeof created)[number]) =>
		(task.metadata as { checklist_role?: string } | null)?.checklist_role === 'parent'
	const parent = created.find(isParent)
	if (!parent) throw new Error('checklist insert returned no rows')
	const children = created.filter((task) => task.id !== parent.id)

	await db
		.insert(relationships)
		.values(
			[
				{ sourceId: loopObjectId, targetId: parent.id, type: 'in_loop' },
				...children.flatMap((child) => [
					{ sourceId: parent.id, targetId: child.id, type: 'breaks_into' },
					{ sourceId: loopObjectId, targetId: child.id, type: 'in_loop' },
				]),
			].map((edge) => ({
				...edge,
				sourceType: 'object',
				targetType: 'object',
				createdBy: actorId,
			})),
		)
		.onConflictDoNothing()

	for (const task of created) {
		const [moved] = await db
			.update(objects)
			.set({ status: 'todo', updatedAt: new Date() })
			.where(eq(objects.id, task.id))
			.returning()
		if (!moved) continue
		await recordEvent(db, {
			workspaceId,
			actorId,
			action: 'status_changed',
			entityType: 'task',
			entityId: task.id,
			data: {
				changes: computeChanges(
					task as unknown as Record<string, unknown>,
					moved as unknown as Record<string, unknown>,
					OBJECT_DIFF_FIELDS,
				),
			},
		})
	}

	return { created: created.length }
}
