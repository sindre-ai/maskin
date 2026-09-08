import { triggers } from '@maskin/db/schema'
import type { SlackSetupMetadata } from '@maskin/shared'
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

/**
 * The subset of `slack_setup` a run may write. `confirmation_posted_at` is
 * absent by construction: it is owned exclusively by `claimSlackConfirmation`,
 * and this write unions in whatever is stored rather than accepting a value.
 */
type SlackSetupWrite = Omit<SlackSetupMetadata, 'confirmation_posted_at'>

/**
 * `slack_setup` write that preserves `confirmation_posted_at` server-side.
 *
 * `setTriggerMetadataKey` keeps *sibling* keys safe, but the setup service
 * builds its `slack_setup` object from a snapshot read at the start of the
 * run, several Slack round-trips earlier. A plain single-key write therefore
 * still clobbers a `confirmation_posted_at` entry that a concurrent run
 * claimed in the meantime — and a dropped claim means the next save re-posts
 * "Maskin is now listening here" into a customer channel.
 *
 * So the confirmation map is unioned with whatever is already stored, in the
 * same statement as the write. Stored entries always survive; the caller's
 * entries are additive. This is also what makes removing every channel from a
 * trigger safe: the run clears `join_attempts` but the channel keeps its
 * confirmation stamp, so re-adding it later does not re-announce.
 */
export function setSlackSetupPreservingConfirmations(slackSetup: SlackSetupWrite): SQL {
	return sql`coalesce(${triggers.metadata}, '{}'::jsonb) || jsonb_build_object(${'slack_setup'}::text, ${JSON.stringify(slackSetup)}::jsonb || jsonb_build_object('confirmation_posted_at', coalesce(${triggers.metadata} -> 'slack_setup' -> 'confirmation_posted_at', '{}'::jsonb)))`
}

/**
 * SET expression for claiming the right to post one channel's confirmation.
 * Writes `slack_setup.confirmation_posted_at[channelId] = at`, creating the
 * intermediate objects if this is the first run for the trigger.
 *
 * Pair with `slackConfirmationUnclaimed()` in the WHERE clause and check the
 * update's row count: the claim and the check happen in one statement under
 * Postgres' row lock, so exactly one of two concurrent runs wins and only the
 * winner calls `chat.postMessage`.
 */
export function claimSlackConfirmation(channelId: string, at: string): SQL {
	const setup = sql`coalesce(${triggers.metadata} -> 'slack_setup', '{}'::jsonb)`
	const confirmations = sql`coalesce(${triggers.metadata} -> 'slack_setup' -> 'confirmation_posted_at', '{}'::jsonb)`
	const nextConfirmations = sql`${confirmations} || jsonb_build_object(${channelId}::text, to_jsonb(${at}::text))`
	const nextSetup = sql`${setup} || jsonb_build_object('confirmation_posted_at'::text, ${nextConfirmations})`
	return sql`coalesce(${triggers.metadata}, '{}'::jsonb) || jsonb_build_object('slack_setup'::text, ${nextSetup})`
}

/** WHERE predicate — true only when `channelId` has no confirmation stamp yet. */
export function slackConfirmationUnclaimed(channelId: string): SQL {
	return sql`NOT (coalesce(${triggers.metadata} -> 'slack_setup' -> 'confirmation_posted_at', '{}'::jsonb) ? ${channelId}::text)`
}
