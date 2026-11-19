import type { Database } from '@maskin/db'
import { sql } from 'drizzle-orm'
import { YoutubeError } from './errors'

/**
 * Daily quota guard for the YouTube Data API. Google gives the whole Maskin project one budget a
 * day (10,000 units), so the count lives in youtube_quota_usage, not on the integration row.
 * Caps: 5,000 units a day for scope global, 1,000 a day per workspace, so one looping agent
 * cannot drain the shared budget for everyone.
 */
export const GLOBAL_DAILY_CAP = 5_000
export const WORKSPACE_DAILY_CAP = 1_000
export const GLOBAL_SCOPE = 'global'

/** Thrown inside the transaction to roll the workspace increment back. */
class GlobalCapReached extends Error {}

/**
 * Check and increment one row in ONE statement, never read-then-write. The cap test runs inside
 * the conflicting update, so parallel calls cannot overshoot. The insert path tests the cap too:
 * a first charge of n above the cap inserts nothing. No row back means the cap is hit.
 *
 * quota_date is computed in SQL on the Pacific calendar, because Google resets quota at midnight
 * Pacific. The database clock decides, and daylight saving is handled by the time zone name.
 * `at` replaces the database clock for tests only.
 */
async function chargeRow(
	tx: Pick<Database, 'execute'>,
	scope: string,
	units: number,
	cap: number,
	at: Date | undefined,
): Promise<boolean> {
	const clock = at ? at.toISOString() : null
	const rows = await tx.execute(sql`
		INSERT INTO youtube_quota_usage (quota_date, scope, units_used)
		SELECT (COALESCE(${clock}::timestamptz, now()) AT TIME ZONE 'America/Los_Angeles')::date,
			${scope}::text, ${units}::int
		WHERE ${units}::int <= ${cap}::int
		ON CONFLICT (quota_date, scope) DO UPDATE
			SET units_used = youtube_quota_usage.units_used + ${units}::int
			WHERE youtube_quota_usage.units_used + ${units}::int <= ${cap}::int
		RETURNING units_used
	`)
	return rows.length > 0
}

/**
 * Charge `units` to the workspace row, then the global row, in one transaction.
 *  - Workspace cap hit: WORKSPACE_QUOTA_EXHAUSTED, global count untouched.
 *  - Global cap hit: the workspace increment is rolled back, QUOTA_EXHAUSTED.
 * Units are charged before the Google call and not refunded on failure, which keeps the guard
 * conservative. The workspace row is always locked before the global row, so concurrent charges
 * cannot deadlock.
 */
export async function chargeYoutubeQuota(
	db: Database,
	workspaceId: string,
	units: number,
	at?: Date,
): Promise<void> {
	if (!Number.isInteger(units) || units < 1) {
		throw new Error(`YouTube quota charge must be a positive whole number, got ${units}`)
	}
	try {
		await db.transaction(async (tx) => {
			if (!(await chargeRow(tx, workspaceId, units, WORKSPACE_DAILY_CAP, at))) {
				throw new YoutubeError({
					code: 'WORKSPACE_QUOTA_EXHAUSTED',
					message: "This workspace's daily YouTube quota is used up.",
					hint: 'The quota resets at midnight Pacific time.',
				})
			}
			if (!(await chargeRow(tx, GLOBAL_SCOPE, units, GLOBAL_DAILY_CAP, at))) {
				throw new GlobalCapReached()
			}
		})
	} catch (err) {
		if (err instanceof GlobalCapReached) {
			throw new YoutubeError({
				code: 'QUOTA_EXHAUSTED',
				message: "Maskin's daily YouTube quota is used up.",
				hint: 'The quota resets at midnight Pacific time.',
			})
		}
		throw err
	}
}

/**
 * Upload bucket (videos.insert): Google allows 100 uploads a day for the project, so Maskin caps
 * it at 20 a day globally and 5 a day per workspace, one unit per upload. The rows live in the
 * same table under their own scope names, so an upload never eats into the data budget and the
 * data budget never blocks an upload.
 */
export const UPLOAD_GLOBAL_DAILY_CAP = 20
export const UPLOAD_WORKSPACE_DAILY_CAP = 5
export const UPLOAD_GLOBAL_SCOPE = 'upload:global'
export const uploadWorkspaceScope = (workspaceId: string) => `upload:${workspaceId}`

/** Charges one upload to the workspace row, then the global row, like chargeYoutubeQuota. */
export async function chargeYoutubeUploadQuota(
	db: Database,
	workspaceId: string,
	at?: Date,
): Promise<void> {
	try {
		await db.transaction(async (tx) => {
			if (
				!(await chargeRow(tx, uploadWorkspaceScope(workspaceId), 1, UPLOAD_WORKSPACE_DAILY_CAP, at))
			) {
				throw new YoutubeError({
					code: 'WORKSPACE_QUOTA_EXHAUSTED',
					message: "This workspace's daily YouTube upload limit is used up.",
					hint: 'The limit resets at midnight Pacific time.',
				})
			}
			if (!(await chargeRow(tx, UPLOAD_GLOBAL_SCOPE, 1, UPLOAD_GLOBAL_DAILY_CAP, at))) {
				throw new GlobalCapReached()
			}
		})
	} catch (err) {
		if (err instanceof GlobalCapReached) {
			throw new YoutubeError({
				code: 'QUOTA_EXHAUSTED',
				message: "Maskin's daily YouTube upload limit is used up.",
				hint: 'The limit resets at midnight Pacific time.',
			})
		}
		throw err
	}
}
