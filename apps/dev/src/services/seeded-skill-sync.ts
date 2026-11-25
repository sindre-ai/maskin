import type { Database } from '@maskin/db'
import { actors, workspaceMembers, workspaceSkills } from '@maskin/db/schema'
import {
	CHIEF_OF_STAFF_DEFAULT,
	INTEGRATION_CONNECT_CHECKLIST_SKILL,
	type SeedSkill,
	parseSkillMd,
	skillNameSchema,
} from '@maskin/shared'
import { and, eq, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { SEEDED_SKILL_HASH_KEY, seededSkillHash } from '../lib/seeded-skill-hash'
import type { AgentStorageManager } from './agent-storage'
import { isRetiredAgent } from './default-heartbeat'
import { attachSkill } from './workspace-bootstrap'

/**
 * Seeded skills the server keeps in step with the code, for the Chief of Staff of every workspace.
 * To ship a new one: add it here. Existing workspaces get it once, and later edits to its text
 * reach every copy nobody has changed.
 */
export const MANAGED_CHIEF_OF_STAFF_SKILLS: readonly SeedSkill[] = [
	INTEGRATION_CONNECT_CHECKLIST_SKILL,
]

export interface SeededSkillBackfillResult {
	workspaces: number
	seeded: number
	skipped: number
	failed: number
}

export interface SeededSkillUpdateResult {
	/** Unchanged copies that got the newer seeded text. */
	updated: number
	/** Copies already holding the current text (hand-made ones) that now carry the stamp. */
	stamped: number
	/** Copies that differ from every text the server wrote: edited, so never touched. */
	leftAlone: number
	failed: number
}

/**
 * Gives the skill to every existing workspace's Chief of Staff that has no skill with that name.
 * A workspace that already has one is left alone, whatever its text, so nothing is overwritten.
 * Safe to run twice. Do not run it on every boot: it would bring the skill back into workspaces
 * that deleted it on purpose (see the boot runner, which runs it once).
 */
export async function backfillChiefOfStaffSkill(
	db: Database,
	agentStorage: AgentStorageManager,
	skill: SeedSkill,
): Promise<SeededSkillBackfillResult> {
	const chiefs = await db
		.select({
			workspaceId: workspaceMembers.workspaceId,
			actorId: workspaceMembers.actorId,
			description: actors.description,
		})
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(eq(actors.name, CHIEF_OF_STAFF_DEFAULT.name))

	const existing = await db
		.select({ workspaceId: workspaceSkills.workspaceId })
		.from(workspaceSkills)
		.where(eq(workspaceSkills.name, skill.name))
	const hasSkill = new Set(existing.map((r) => r.workspaceId))

	const chiefByWorkspace = new Map<string, string>()
	for (const chief of chiefs) {
		if (isRetiredAgent(chief.description)) continue
		if (!chiefByWorkspace.has(chief.workspaceId))
			chiefByWorkspace.set(chief.workspaceId, chief.actorId)
	}

	const result: SeededSkillBackfillResult = {
		workspaces: chiefByWorkspace.size,
		seeded: 0,
		skipped: 0,
		failed: 0,
	}

	for (const [workspaceId, chiefId] of chiefByWorkspace) {
		if (hasSkill.has(workspaceId)) {
			result.skipped++
			continue
		}
		try {
			await attachSkill(db, agentStorage, workspaceId, chiefId, chiefId, skill)
			// attachSkill logs and swallows its own errors, so confirm the skill really exists.
			const [created] = await db
				.select({ id: workspaceSkills.id })
				.from(workspaceSkills)
				.where(
					and(eq(workspaceSkills.workspaceId, workspaceId), eq(workspaceSkills.name, skill.name)),
				)
				.limit(1)
			if (!created) throw new Error('skill row missing after attach')
			result.seeded++
			logger.info('Seeded skill added to workspace', { workspaceId, skill: skill.name })
		} catch (err) {
			result.failed++
			logger.error('Seeded skill backfill failed for a workspace', {
				workspaceId,
				skill: skill.name,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	return result
}

/**
 * Brings copies of a seeded skill up to the current seeded text, but only copies nobody has edited.
 *
 * A copy counts as unedited when the hash of its text equals the hash stamped in its metadata when
 * the server last wrote it. Edited copies, and copies with no stamp and different text (made by
 * hand), are never touched. A copy that already holds the current text only gets the stamp, so
 * the next edit of the seed reaches it. Safe to run on every boot: with nothing to do it is one
 * select.
 */
export async function updateUnchangedSeededSkills(
	db: Database,
	agentStorage: AgentStorageManager,
	skill: SeedSkill,
): Promise<SeededSkillUpdateResult> {
	const currentHash = seededSkillHash(skill.content)
	const result: SeededSkillUpdateResult = { updated: 0, stamped: 0, leftAlone: 0, failed: 0 }

	const rows = await db
		.select({
			id: workspaceSkills.id,
			workspaceId: workspaceSkills.workspaceId,
			content: workspaceSkills.content,
			metadata: workspaceSkills.metadata,
		})
		.from(workspaceSkills)
		.where(eq(workspaceSkills.name, skill.name))

	for (const row of rows) {
		const stored = readStamp(row.metadata)
		if (stored === currentHash && seededSkillHash(row.content) === currentHash) continue
		// Cheap pre-check outside the lock; the locked check below is the one that counts.
		const isCurrentText = seededSkillHash(row.content) === currentHash
		const isUnchangedOldSeed = stored !== null && seededSkillHash(row.content) === stored
		if (!isCurrentText && !isUnchangedOldSeed) {
			result.leftAlone++
			continue
		}
		try {
			const outcome = await applySeededText(db, agentStorage, row.id, skill, currentHash)
			if (outcome === 'updated') result.updated++
			else if (outcome === 'stamped') result.stamped++
			else result.leftAlone++
		} catch (err) {
			result.failed++
			logger.error('Seeded skill update failed for a workspace', {
				workspaceId: row.workspaceId,
				skill: skill.name,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	return result
}

function readStamp(metadata: unknown): string | null {
	if (!metadata || typeof metadata !== 'object') return null
	const value = (metadata as Record<string, unknown>)[SEEDED_SKILL_HASH_KEY]
	return typeof value === 'string' ? value : null
}

/** Re-checks under a row lock so an edit that lands during the run is never overwritten. */
async function applySeededText(
	db: Database,
	agentStorage: AgentStorageManager,
	skillId: string,
	skill: SeedSkill,
	currentHash: string,
): Promise<'updated' | 'stamped' | 'left_alone'> {
	return db.transaction(async (tx) => {
		const [locked] = await tx
			.select()
			.from(workspaceSkills)
			.where(eq(workspaceSkills.id, skillId))
			.for('update')
			.limit(1)
		if (!locked) return 'left_alone'

		const lockedHash = seededSkillHash(locked.content)
		const stamp = sql`coalesce(${workspaceSkills.metadata}, '{}'::jsonb) || jsonb_build_object(${SEEDED_SKILL_HASH_KEY}::text, ${currentHash}::text)`

		if (lockedHash === currentHash) {
			await tx
				.update(workspaceSkills)
				.set({ metadata: stamp })
				.where(eq(workspaceSkills.id, skillId))
			return 'stamped'
		}
		if (lockedHash !== readStamp(locked.metadata)) return 'left_alone'

		let description: string | null = null
		let isValid = false
		try {
			const parsed = parseSkillMd(skill.content)
			description = parsed.description ?? null
			isValid = skillNameSchema.safeParse(parsed.name).success
		} catch {
			// Keep the defaults: the row is saved as not valid, like attachSkill does.
		}
		const { sizeBytes } = await agentStorage.putWorkspaceSkill(
			locked.workspaceId,
			skillId,
			skill.content,
		)
		await tx
			.update(workspaceSkills)
			.set({
				content: skill.content,
				description,
				sizeBytes,
				isValid,
				metadata: stamp,
				updatedAt: new Date(),
			})
			.where(eq(workspaceSkills.id, skillId))
		return 'updated'
	})
}
