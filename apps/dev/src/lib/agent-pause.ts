import { actors } from '@maskin/db/schema'
import { type SQL, sql } from 'drizzle-orm'

/**
 * Who paused an agent. A person's Pause button and the idle watcher both write
 * agentState 'paused', and only a person's pause is meant to hold against chat
 * messages and @mentions. The marker lives in actors.metadata, so no column:
 * `paused_by: 'human'` is set by the Pause route and removed by Run and by the
 * idle watcher's own paused write.
 */
const PAUSED_BY_KEY = 'paused_by'

/** True when a person paused this agent and it has not been resumed since. */
export function isHumanPaused(actor: { agentState: string; metadata: unknown }): boolean {
	if (actor.agentState !== 'paused') return false
	const metadata = actor.metadata as Record<string, unknown> | null
	return metadata?.[PAUSED_BY_KEY] === 'human'
}

/** Value for actors.metadata in the Pause route: keeps the other keys and adds the marker. */
export const withHumanPauseMarker: SQL = sql`COALESCE(${actors.metadata}, '{}'::jsonb) || ${JSON.stringify({ [PAUSED_BY_KEY]: 'human' })}::jsonb`

/** Value for actors.metadata on resume or auto-pause: keeps the other keys and drops the marker. */
export const withoutHumanPauseMarker: SQL = sql`COALESCE(${actors.metadata}, '{}'::jsonb) - ${PAUSED_BY_KEY}::text`
