import type { Database } from '@maskin/db'
import { triggers } from '@maskin/db/schema'
import { type SQL, and, inArray, or, sql } from 'drizzle-orm'

/** Escape LIKE wildcards (percent, underscore) and the escape character itself. */
export function escapeLike(value: string): string {
	return value.replace(/[%_\\]/g, '\\$&')
}

// The words a person can search a trigger by, other than its prompt. `kind` is
// what the MCP list calls it: a cron is recurring, a reminder is one-time.
const kindLabel = sql`CASE ${triggers.type} WHEN 'cron' THEN 'recurring cron' WHEN 'reminder' THEN 'one-time reminder' ELSE ${triggers.type} END`
const statusLabel = sql`CASE WHEN ${triggers.enabled} THEN 'enabled' ELSE 'disabled' END`
const scheduleLabel = sql`COALESCE(${triggers.config}->>'expression', ${triggers.config}->>'scheduled_at', concat_ws(' ', ${triggers.config}->>'entity_type', ${triggers.config}->>'action'))`

/**
 * Matches a trigger on everything except its prompt: name, agent name, agent
 * id, kind, status, schedule and the name of a loop it is a step of. `q` is
 * split on whitespace and every word has to match somewhere, so "rune hourly"
 * finds Rune's recurring triggers. Case-insensitive; LIKE wildcards are literal.
 */
export function triggerSearchCondition(q: string): SQL | undefined {
	const words = q.split(/\s+/).filter(Boolean)
	const perWord = words.map((word) => {
		const pattern = `%${escapeLike(word)}%`
		const haystack = sql`concat_ws(' ', ${triggers.name}, ${triggers.targetActorId}::text, ${kindLabel}, ${statusLabel}, ${scheduleLabel})`
		// Columns inside the subqueries are written out with their table: drizzle leaves the
		// table off a column in a single-table select, and the names clash with `triggers`.
		return or(
			sql`${haystack} ILIKE ${pattern} ESCAPE '\\'`,
			sql`EXISTS (SELECT 1 FROM actors WHERE actors.id = triggers.target_actor_id AND actors.name ILIKE ${pattern} ESCAPE '\\')`,
			sql`EXISTS (SELECT 1 FROM objects WHERE objects.workspace_id = triggers.workspace_id AND objects.type = 'loop' AND objects.metadata -> 'trigger_ids' ? (triggers.id)::text AND objects.title ILIKE ${pattern} ESCAPE '\\')`,
		)
	})
	return perWord.length ? and(...perWord) : undefined
}

/**
 * When each trigger last fired, as an ISO string, for the given ids. One
 * newest-first index probe per trigger, so a trigger that fires hourly costs
 * the same as one that never fired. Missing ids mean it has not fired.
 */
export async function fetchLastRunAt(
	db: Database,
	workspaceId: string,
	triggerIds: string[],
): Promise<Map<string, string>> {
	const out = new Map<string, string>()
	if (triggerIds.length === 0) return out
	const rows = await db
		.select({
			id: triggers.id,
			lastRunAt: sql<Date | string | null>`(
				SELECT events.created_at FROM events
				WHERE events.workspace_id = ${workspaceId}
					AND events.entity_id = triggers.id
					AND events.action = 'trigger_fired'
				ORDER BY events.id DESC LIMIT 1
			)`,
		})
		.from(triggers)
		.where(inArray(triggers.id, triggerIds))
	for (const row of rows) {
		if (row.lastRunAt) out.set(row.id, new Date(row.lastRunAt).toISOString())
	}
	return out
}
