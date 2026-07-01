import type { Database } from '@maskin/db'
import { events, objects } from '@maskin/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'

/**
 * Two-pass GitHub deployment-status → bet/task attribution (bet/deploy-event T3).
 *
 * Pass 1 — SHA match against stored `push` / `pull_request.merged` events:
 *   the deployment payload's SHA equals a stored `head_commit_sha` (push tip)
 *   or `merge_commit_sha` (PR merge into base). Read the head branch from the
 *   matched event, then find a bet/task with `metadata.branch = <branch>`.
 *
 * Pass 2 — fallbacks when no merge event is stored:
 *   (a) direct branch match: `bet.metadata.branch` equals the deploy payload's
 *       `deployment_ref` (with `refs/heads/` stripped).
 *   (b) PR-head-SHA match: a stored `pull_request` event whose `pr_head_sha`
 *       equals the deploy SHA — resolve via that event's `pr_head_ref`.
 *
 * On a match, a single transaction takes `SELECT ... FOR UPDATE` on the target
 * row, guards on an already-set `deployed_at` (collision → log, no overwrite),
 * and does one `UPDATE objects` that sets `deployed_at` and clears
 * `awaiting_deploy` to `false`. For a matched `task`, `last_deployed_at` is set
 * on the task row in the same UPDATE. Row-level locking scales horizontally —
 * concurrent distinct-SHA deployments lock different rows.
 */

export interface AttributeDeploymentArgs {
	db: Database
	workspaceId: string
	sha: string
	deployedAt: string
	deploymentRef?: string
	deliveryId?: string | null
}

export interface AttributeDeploymentResult {
	matched: boolean
	objectId?: string
	objectType?: 'bet' | 'task'
	reason?: 'pass1_push' | 'pass1_pr_merge' | 'pass2_branch' | 'pass2_pr_head_sha'
	collision?: boolean
}

/**
 * Strip `refs/heads/` prefix from a Git ref so it can be compared to a bare
 * branch name (which is how `bet.metadata.branch` is stored).
 */
function stripRefsHeads(ref: string | undefined | null): string | null {
	if (typeof ref !== 'string' || ref.length === 0) return null
	return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

async function findBetOrTaskByBranch(
	db: Database,
	workspaceId: string,
	branch: string,
): Promise<{ id: string; type: 'bet' | 'task' } | null> {
	const rows = await db
		.select({ id: objects.id, type: objects.type })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				inArray(objects.type, ['bet', 'task']),
				sql`${objects.metadata}->>'branch' = ${branch}`,
			),
		)
		.limit(1)
	const row = rows[0]
	if (!row) return null
	return { id: row.id, type: row.type as 'bet' | 'task' }
}

async function findBranchFromMergeEvent(
	db: Database,
	workspaceId: string,
	sha: string,
): Promise<{ branch: string; reason: 'pass1_push' | 'pass1_pr_merge' } | null> {
	const rows = await db
		.select({ entityType: events.entityType, data: events.data })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, workspaceId),
				inArray(events.entityType, ['github.push', 'github.pull_request']),
				sql`(${events.data}->>'head_commit_sha' = ${sha} OR ${events.data}->>'merge_commit_sha' = ${sha})`,
			),
		)
		.limit(1)
	const row = rows[0]
	if (!row) return null
	const data = (row.data ?? {}) as Record<string, unknown>
	if (row.entityType === 'github.push') {
		const branch = stripRefsHeads(data.ref as string | undefined)
		if (!branch) return null
		return { branch, reason: 'pass1_push' }
	}
	const branch = stripRefsHeads(data.pr_head_ref as string | undefined)
	if (!branch) return null
	return { branch, reason: 'pass1_pr_merge' }
}

async function findBranchFromPrHeadSha(
	db: Database,
	workspaceId: string,
	sha: string,
): Promise<string | null> {
	const rows = await db
		.select({ data: events.data })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, workspaceId),
				eq(events.entityType, 'github.pull_request'),
				sql`${events.data}->>'pr_head_sha' = ${sha}`,
			),
		)
		.limit(1)
	const row = rows[0]
	if (!row) return null
	const data = (row.data ?? {}) as Record<string, unknown>
	return stripRefsHeads(data.pr_head_ref as string | undefined)
}

/**
 * Atomically record the deployment on the target row. Locks the row, guards
 * against overwrite, and does the merge in one UPDATE so a partial write is
 * impossible.
 */
async function writeAttribution(
	db: Database,
	target: { id: string; type: 'bet' | 'task' },
	deployedAt: string,
	deliveryId: string | null,
): Promise<{ collision: boolean }> {
	return db.transaction(async (tx) => {
		const [locked] = await tx
			.select({ id: objects.id, type: objects.type, metadata: objects.metadata })
			.from(objects)
			.where(eq(objects.id, target.id))
			.for('update')
			.limit(1)

		if (!locked) return { collision: false }

		const existing = (locked.metadata ?? {}) as Record<string, unknown>
		const key = locked.type === 'task' ? 'last_deployed_at' : 'deployed_at'
		if (typeof existing[key] === 'string' && existing[key]) {
			logger.info('deployment_status attribution collision — existing timestamp preserved', {
				objectId: locked.id,
				objectType: locked.type,
				existing: existing[key],
				attempted: deployedAt,
				deliveryId,
			})
			return { collision: true }
		}

		const nextMetadata: Record<string, unknown> = {
			...existing,
			[key]: deployedAt,
		}
		if (locked.type === 'bet') {
			nextMetadata.awaiting_deploy = false
		}

		await tx
			.update(objects)
			.set({ metadata: nextMetadata, updatedAt: new Date() })
			.where(eq(objects.id, target.id))

		return { collision: false }
	})
}

export async function attributeDeploymentToObject(
	args: AttributeDeploymentArgs,
): Promise<AttributeDeploymentResult> {
	const { db, workspaceId, sha, deployedAt, deploymentRef, deliveryId } = args
	const delivery = deliveryId ?? null

	// Pass 1 — resolve branch from a stored merge event, then map to bet/task.
	const pass1 = await findBranchFromMergeEvent(db, workspaceId, sha)
	if (pass1) {
		const target = await findBetOrTaskByBranch(db, workspaceId, pass1.branch)
		if (target) {
			const { collision } = await writeAttribution(db, target, deployedAt, delivery)
			return {
				matched: true,
				objectId: target.id,
				objectType: target.type,
				reason: pass1.reason,
				collision,
			}
		}
	}

	// Pass 2(a) — direct branch match against the deploy payload's ref.
	const refBranch = stripRefsHeads(deploymentRef)
	if (refBranch) {
		const target = await findBetOrTaskByBranch(db, workspaceId, refBranch)
		if (target) {
			const { collision } = await writeAttribution(db, target, deployedAt, delivery)
			return {
				matched: true,
				objectId: target.id,
				objectType: target.type,
				reason: 'pass2_branch',
				collision,
			}
		}
	}

	// Pass 2(b) — the deploy SHA equals a stored PR's head SHA (pre-merge tip).
	const prBranch = await findBranchFromPrHeadSha(db, workspaceId, sha)
	if (prBranch) {
		const target = await findBetOrTaskByBranch(db, workspaceId, prBranch)
		if (target) {
			const { collision } = await writeAttribution(db, target, deployedAt, delivery)
			return {
				matched: true,
				objectId: target.id,
				objectType: target.type,
				reason: 'pass2_pr_head_sha',
				collision,
			}
		}
	}

	return { matched: false }
}
