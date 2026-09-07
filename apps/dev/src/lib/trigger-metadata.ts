import { triggers } from '@maskin/db/schema'
import { type SQL, sql } from 'drizzle-orm'

/**
 * Atomic single-key writes against `triggers.metadata` (jsonb).
 *
 * Three independent writers touch this column — `runSlackTriggerSetup`
 * (`slack_setup`), `handleMemberLeftChannel` (`auto_paused`), and the
 * `clear_auto_paused` branch of `PATCH /api/triggers/:id`. Each only owns its
 * own key and must preserve the others'.
 *
 * A read-modify-write in JS (`SELECT metadata` → spread → `UPDATE`) cannot do
 * that: a sibling write landing between the SELECT and the UPDATE is silently
 * clobbered by the stale spread. The concrete failure that motivated these
 * helpers: the bot is kicked mid-save, `handleMemberLeftChannel` stamps
 * `auto_paused`, and the setup service's in-flight update writes back the
 * pre-kick object — leaving the trigger disabled with no red banner and no
 * Resume affordance, which is the exact state the feature exists to prevent.
 *
 * These build the merge as a single SQL expression so the read and the write
 * happen in one statement, under Postgres' row lock. Sibling keys survive by
 * construction rather than by timing.
 */

/** `metadata = coalesce(metadata,'{}') || {key: value}` — sets one key, keeps siblings. */
export function setTriggerMetadataKey(key: string, value: unknown): SQL {
	return sql`coalesce(${triggers.metadata}, '{}'::jsonb) || jsonb_build_object(${key}::text, ${JSON.stringify(value)}::jsonb)`
}

/** `metadata = coalesce(metadata,'{}') - key` — removes one key, keeps siblings. */
export function removeTriggerMetadataKey(key: string): SQL {
	return sql`coalesce(${triggers.metadata}, '{}'::jsonb) - ${key}::text`
}
