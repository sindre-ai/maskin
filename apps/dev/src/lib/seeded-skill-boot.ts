import type { Database } from '@maskin/db'
import { sql } from 'drizzle-orm'
import type { AgentStorageManager } from '../services/agent-storage'
import {
	MANAGED_CHIEF_OF_STAFF_SKILLS,
	type SeededSkillBackfillResult,
	type SeededSkillUpdateResult,
	backfillChiefOfStaffSkill,
	updateUnchangedSeededSkills,
} from '../services/seeded-skill-sync'
import { logger } from './logger'

/**
 * Done markers are rows in `_migrations`, the table the migration runner already uses to remember
 * what ran. The names never match a migration file, so the runner ignores them.
 */
export const SEEDED_SKILL_BACKFILL_MARKER_PREFIX = 'runtime:seeded-skill-backfill:'

/** Serialises replicas booting at once: the second waits here, then sees the markers. */
const BOOT_LOCK_KEY = 'maskin:boot-seeded-skill-sync'

export interface SeededSkillBootResult {
	skill: string
	backfill: SeededSkillBackfillResult | 'already_done'
	update: SeededSkillUpdateResult
}

export type SeededSkillBootOutcome =
	| { status: 'done'; results: SeededSkillBootResult[] }
	| { status: 'incomplete'; results: SeededSkillBootResult[] }
	| { status: 'failed' }

/**
 * Startup sync of the seeded Chief of Staff skills, with nobody switching anything on.
 *
 * Per skill, in this order:
 * 1. Backfill, once per database: every existing workspace without the skill gets it. The marker
 *    is written only when no workspace failed, so a partial run retries on the next boot; the
 *    backfill skips workspaces that already have the skill, which makes the retry cheap. Running
 *    it on every boot would bring the skill back into workspaces that deleted it on purpose.
 * 2. Update, on every boot: copies nobody has edited get the current seeded text. Edited copies
 *    are never touched.
 *
 * Never throws: a failure is logged and the API starts anyway. Do not await it before serve().
 */
export async function runSeededSkillSyncOnBoot(
	db: Database,
	agentStorage: AgentStorageManager,
): Promise<SeededSkillBootOutcome> {
	try {
		// The lock is held on one connection for the whole run, like the other boot backfills, so a
		// second replica waits here and then finds the markers.
		return await db.transaction(async (tx): Promise<SeededSkillBootOutcome> => {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${BOOT_LOCK_KEY}))`)

			const results: SeededSkillBootResult[] = []
			let incomplete = false

			for (const skill of MANAGED_CHIEF_OF_STAFF_SKILLS) {
				const marker = `${SEEDED_SKILL_BACKFILL_MARKER_PREFIX}${skill.name}`
				const done = await tx.execute(sql`SELECT 1 FROM "_migrations" WHERE "name" = ${marker}`)

				let backfill: SeededSkillBackfillResult | 'already_done' = 'already_done'
				if (done.length === 0) {
					backfill = await backfillChiefOfStaffSkill(db, agentStorage, skill)
					if (backfill.failed > 0) {
						incomplete = true
						logger.warn('Seeded skill backfill incomplete; retrying next boot', {
							skill: skill.name,
							...backfill,
						})
					} else {
						await tx.execute(sql`INSERT INTO "_migrations" ("name") VALUES (${marker})`)
					}
				}

				const update = await updateUnchangedSeededSkills(db, agentStorage, skill)
				if (update.failed > 0) incomplete = true
				results.push({ skill: skill.name, backfill, update })
				logger.info('Seeded skill sync finished', { skill: skill.name, backfill, update })
			}

			return { status: incomplete ? 'incomplete' : 'done', results }
		})
	} catch (err) {
		logger.error('Seeded skill sync failed; the API keeps starting', {
			error: err instanceof Error ? err.message : String(err),
		})
		return { status: 'failed' }
	}
}
