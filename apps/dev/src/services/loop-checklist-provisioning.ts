import type { Database, Transaction } from '@maskin/db'
import { objects, relationships } from '@maskin/db/schema'
import { OBJECT_DIFF_FIELDS, computeChanges } from '@maskin/shared'
import { and, eq, sql } from 'drizzle-orm'
import { postComment } from '../lib/comments'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import type { LoopChecklist } from '../lib/marketplace-loops/loop-settings'
import { startSession } from './session-lifecycle'

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
 *
 * A move to todo wakes no agent but the Developer, so once the install has committed the route
 * also calls startLoopChecklistSession to start the driver on the list straight away.
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
}): Promise<{ created: number; parentTaskId: string | null }> {
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
	if (existing) return { created: 0, parentTaskId: null }

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

	return { created: created.length, parentTaskId: parent.id }
}

/** The prompt the driver gets when the install starts it on the checklist. */
export function buildChecklistStartPrompt(input: {
	loopName: string
	loopObjectId: string
	parentTaskId: string
}): string {
	return [
		`The "${input.loopName}" flow was just installed in this workspace and came with an onboarding checklist. You drive it. Nobody has started on it yet.`,
		'',
		`Flow object ID: ${input.loopObjectId}`,
		`Checklist parent task ID: ${input.parentTaskId}`,
		'',
		'Work the checklist now. Read the parent task and the child tasks it breaks into. Do what you can without the owner: propose best guesses from what the workspace already says, research, and file pages. Move each child task as you go.',
		'Where only the owner can answer, ask in the flow chat (create_chat with the flow object as subject, which opens or rejoins it). Ask at most 3 questions at a time, each with your best guess and a recommendation, so the owner can confirm in one word.',
		'Report setup done only when every child task is done or discarded. Your next owner check picks up whatever is left.',
	].join('\n')
}

/**
 * Starts the checklist's driver on the list right after the install commits, so the installer
 * does not wait for the next owner check. At most one start request per install: the idempotency
 * key is the install id, so a repeat call finds the first session instead of starting another.
 *
 * Best effort. The install has already committed, so a failure to start (no model access, plan
 * cap, daily budget) is logged and noted in a comment on the flow, and the next owner check picks
 * the list up. Never throws.
 */
export async function startLoopChecklistSession(
	input: {
		db: DbHandle
		workspaceId: string
		/** The person who installed the flow. */
		installerId: string
		installId: string
		loop: { objectId: string; name: string }
		parentTaskId: string
		driverActorId: string | null
	},
	deps: { start?: typeof startSession } = {},
): Promise<{ started: boolean }> {
	const { db, workspaceId, installerId, installId, loop, parentTaskId, driverActorId } = input
	if (!driverActorId) return { started: false }
	const start = deps.start ?? startSession

	try {
		await start({
			workspaceId,
			actorId: driverActorId,
			callerKind: 'internal',
			actionPrompt: buildChecklistStartPrompt({
				loopName: loop.name,
				loopObjectId: loop.objectId,
				parentTaskId,
			}),
			config: { idempotencyKey: `loop-checklist-start:${installId}` },
			createdBy: installerId,
			initiatedFromObjectId: parentTaskId,
			await: 'none',
		})
		return { started: true }
	} catch (err) {
		logger.warn('Could not start the checklist session after install', {
			workspaceId,
			installId,
			error: String(err),
		})
		try {
			await postComment(db, {
				workspaceId,
				actorId: installerId,
				entityId: loop.objectId,
				content:
					'The agent could not start on the setup checklist right after install. The checklist tasks are created, and the agent picks them up at its next owner check.',
				attention: 1,
			})
		} catch (commentErr) {
			logger.warn('Could not note the failed checklist start on the flow', {
				workspaceId,
				installId,
				error: String(commentErr),
			})
		}
		return { started: false }
	}
}
