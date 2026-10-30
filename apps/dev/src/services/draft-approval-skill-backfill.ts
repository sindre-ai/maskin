import type { Database } from '@maskin/db'
import { actors, agentSkills, workspaceSkills } from '@maskin/db/schema'
import { DRAFT_APPROVAL_TASKS_SKILL, MASKIN_WAY_OF_WORKING_SKILL } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { logger } from '../lib/logger'
import type { AgentStorageManager } from './agent-storage'
import { isRetiredAgent } from './default-heartbeat'
import { attachSkill } from './workspace-bootstrap'

export interface DraftApprovalSkillBackfillResult {
	workspaces: number
	seeded: number
	skipped: number
	failed: number
	/** Workspaces that got the skill (or, in a dry run, would get it). Undo by deleting these. */
	seededWorkspaceIds: string[]
}

/**
 * Gives every existing workspace the draft-approval-tasks skill, on the agents that carry
 * maskin-way-of-working (the default roster). A workspace that already has a skill with that
 * name is left alone, so an edited copy is never overwritten. Safe to run twice.
 *
 * With dryRun it only counts: nothing is written, and "seeded" is the number it would add.
 */
export async function backfillDraftApprovalSkill(
	db: Database,
	agentStorage: AgentStorageManager,
	{ dryRun = false }: { dryRun?: boolean } = {},
): Promise<DraftApprovalSkillBackfillResult> {
	const rows = await db
		.select({
			workspaceId: workspaceSkills.workspaceId,
			actorId: agentSkills.actorId,
			description: actors.description,
		})
		.from(workspaceSkills)
		.innerJoin(agentSkills, eq(agentSkills.workspaceSkillId, workspaceSkills.id))
		.innerJoin(actors, eq(actors.id, agentSkills.actorId))
		.where(eq(workspaceSkills.name, MASKIN_WAY_OF_WORKING_SKILL.name))

	const existing = await db
		.select({ workspaceId: workspaceSkills.workspaceId })
		.from(workspaceSkills)
		.where(eq(workspaceSkills.name, DRAFT_APPROVAL_TASKS_SKILL.name))
	const hasSkill = new Set(existing.map((r) => r.workspaceId))

	const agentsByWorkspace = new Map<string, string[]>()
	for (const row of rows) {
		if (isRetiredAgent(row.description)) continue
		const list = agentsByWorkspace.get(row.workspaceId) ?? []
		list.push(row.actorId)
		agentsByWorkspace.set(row.workspaceId, list)
	}

	const result: DraftApprovalSkillBackfillResult = {
		workspaces: agentsByWorkspace.size,
		seeded: 0,
		skipped: 0,
		failed: 0,
		seededWorkspaceIds: [],
	}

	for (const [workspaceId, actorIds] of agentsByWorkspace) {
		if (hasSkill.has(workspaceId)) {
			result.skipped++
			continue
		}
		if (dryRun) {
			result.seeded++
			result.seededWorkspaceIds.push(workspaceId)
			continue
		}
		try {
			for (const actorId of actorIds) {
				// attachSkill creates the workspace skill on the first call and reuses it after.
				await attachSkill(
					db,
					agentStorage,
					workspaceId,
					actorIds[0] as string,
					actorId,
					DRAFT_APPROVAL_TASKS_SKILL,
				)
			}
			// attachSkill logs and swallows its own errors, so confirm the skill really exists.
			const [created] = await db
				.select({ id: workspaceSkills.id })
				.from(workspaceSkills)
				.where(
					and(
						eq(workspaceSkills.workspaceId, workspaceId),
						eq(workspaceSkills.name, DRAFT_APPROVAL_TASKS_SKILL.name),
					),
				)
				.limit(1)
			if (!created) throw new Error('skill row missing after attach')
			result.seeded++
			result.seededWorkspaceIds.push(workspaceId)
			logger.info('Draft approval skill added to workspace', { workspaceId })
		} catch (err) {
			result.failed++
			logger.error('Draft approval skill backfill failed for a workspace', {
				workspaceId,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	return result
}
