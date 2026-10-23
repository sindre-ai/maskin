import type { Database } from '@maskin/db'
import { sql } from 'drizzle-orm'
import {
	type HeartbeatBackfillResult,
	backfillDefaultHeartbeats,
} from '../services/default-heartbeat'
import { logger } from './logger'

/** Set to 1 for one deploy to run the backfill, then remove it. */
export const HEARTBEAT_BACKFILL_ENV = 'RUN_HEARTBEAT_BACKFILL'

/**
 * The done marker is a row in `_migrations`, the table the migration runner already uses to
 * remember what ran. Its name never matches a migration file, so the runner ignores it.
 */
export const HEARTBEAT_BACKFILL_MARKER = 'runtime:default-heartbeat-backfill'

/** Serialises replicas booting at once: the second waits here, then sees the marker. */
const BOOT_LOCK_KEY = 'maskin:boot-default-heartbeat-backfill'

export type HeartbeatBootBackfillOutcome =
	| { status: 'disabled' }
	| { status: 'already_done' }
	| { status: 'done'; result: HeartbeatBackfillResult }
	| { status: 'failed' }

/**
 * One-off startup backfill of the default Heartbeat for every agent in every workspace.
 *
 * Runs only when RUN_HEARTBEAT_BACKFILL=1, and only once: the marker is written in the same
 * transaction as the backfill, so it exists exactly when the backfill committed. A failed run
 * leaves no marker and rolls back, so the next boot with the flag set tries again. Running it
 * on every boot would bring back Heartbeats people deleted on purpose.
 *
 * Never throws: a failure is logged and the API starts anyway. Do not await it before serve().
 */
export async function runDefaultHeartbeatBackfillOnBoot(
	db: Database,
	env: NodeJS.ProcessEnv = process.env,
): Promise<HeartbeatBootBackfillOutcome> {
	if (env[HEARTBEAT_BACKFILL_ENV] !== '1') return { status: 'disabled' }

	try {
		const outcome = await db.transaction(async (tx): Promise<HeartbeatBootBackfillOutcome> => {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${BOOT_LOCK_KEY}))`)

			const done = await tx.execute(
				sql`SELECT 1 FROM "_migrations" WHERE "name" = ${HEARTBEAT_BACKFILL_MARKER}`,
			)
			if (done.length > 0) return { status: 'already_done' }

			// The transaction is a drop-in for the database here: the backfill nests its own work
			// in a savepoint, so its writes and the marker commit or roll back together.
			const result = await backfillDefaultHeartbeats(tx as unknown as Database)
			await tx.execute(
				sql`INSERT INTO "_migrations" ("name") VALUES (${HEARTBEAT_BACKFILL_MARKER})`,
			)
			return { status: 'done', result }
		})

		if (outcome.status === 'done') {
			logger.info('Default Heartbeat boot backfill done. Remove RUN_HEARTBEAT_BACKFILL.', {
				...outcome.result,
			})
		} else {
			logger.info(
				'Default Heartbeat boot backfill skipped: already done. Remove RUN_HEARTBEAT_BACKFILL.',
			)
		}
		return outcome
	} catch (err) {
		logger.error('Default Heartbeat boot backfill failed; the API keeps starting', {
			error: err instanceof Error ? err.message : String(err),
		})
		return { status: 'failed' }
	}
}
