import type { Database } from '@maskin/db'
import { sql } from 'drizzle-orm'
import type { AgentStorageManager } from '../services/agent-storage'
import {
	type DraftApprovalSkillBackfillResult,
	backfillDraftApprovalSkill,
} from '../services/draft-approval-skill-backfill'
import { logger } from './logger'

/**
 * The done marker is a row in `_migrations`, the table the migration runner already uses to
 * remember what ran. Its name never matches a migration file, so the runner ignores it.
 */
export const DRAFT_APPROVAL_SKILL_BACKFILL_MARKER = 'runtime:draft-approval-skill-backfill'

/** Serialises replicas booting at once: the second waits here, then sees the marker. */
const BOOT_LOCK_KEY = 'maskin:boot-draft-approval-skill-backfill'

export type DraftApprovalSkillBootOutcome =
	| { status: 'already_done' }
	| { status: 'done'; result: DraftApprovalSkillBackfillResult }
	| { status: 'incomplete'; result: DraftApprovalSkillBackfillResult }
	| { status: 'failed' }

/**
 * One-off startup backfill of the draft-approval-tasks skill into existing workspaces.
 *
 * Runs once per database. The marker is written only when no workspace failed, so a partial
 * run retries on the next boot; the backfill skips workspaces that already have the skill,
 * which makes the retry cheap. Running it on every boot would bring the skill back into
 * workspaces that deleted it on purpose.
 *
 * Never throws: a failure is logged and the API starts anyway. Do not await it before serve().
 */
export async function runDraftApprovalSkillBackfillOnBoot(
	db: Database,
	agentStorage: AgentStorageManager,
): Promise<DraftApprovalSkillBootOutcome> {
	try {
		// The lock is held on one connection for the whole run, like the heartbeat backfill,
		// so a second replica waits here and then finds the marker.
		return await db.transaction(async (tx): Promise<DraftApprovalSkillBootOutcome> => {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${BOOT_LOCK_KEY}))`)

			const done = await tx.execute(
				sql`SELECT 1 FROM "_migrations" WHERE "name" = ${DRAFT_APPROVAL_SKILL_BACKFILL_MARKER}`,
			)
			if (done.length > 0) return { status: 'already_done' }

			const result = await backfillDraftApprovalSkill(db, agentStorage)
			if (result.failed > 0) {
				logger.warn('Draft approval skill boot backfill incomplete; retrying next boot', {
					...result,
				})
				return { status: 'incomplete', result }
			}
			await tx.execute(
				sql`INSERT INTO "_migrations" ("name") VALUES (${DRAFT_APPROVAL_SKILL_BACKFILL_MARKER})`,
			)
			logger.info('Draft approval skill boot backfill done', { ...result })
			return { status: 'done', result }
		})
	} catch (err) {
		logger.error('Draft approval skill boot backfill failed; the API keeps starting', {
			error: err instanceof Error ? err.message : String(err),
		})
		return { status: 'failed' }
	}
}
