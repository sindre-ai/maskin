import type { Database } from '@maskin/db'
import { type SQL, sql } from 'drizzle-orm'
import {
	FRECENCY_HALF_LIFE_DAYS,
	FRECENCY_MAX_BONUS,
	FRECENCY_POINTS_PER_OPEN,
} from '../lib/search-rank'

/**
 * The ranking bonus, in points, of a search_opens row aliased `so`: the stored count decayed to
 * now, times the points per open, capped. Read by the search score.
 */
export function frecencyBonusSql(): SQL {
	const ageDays = sql`extract(epoch from (now() - so.last_opened_at)) / 86400.0`
	return sql`floor(least(${FRECENCY_MAX_BONUS}::double precision,
		so.decayed_opens * power(0.5, ${ageDays} / ${FRECENCY_HALF_LIFE_DAYS}::double precision)
			* ${FRECENCY_POINTS_PER_OPEN}::double precision))::int`
}

/**
 * Records that `actorId` opened a search result. One row per person and result: the old count is
 * halved per FRECENCY_HALF_LIFE_DAYS since the last open, then 1 is added, so the stored value is
 * always "opens as of last_opened_at" and search only has to decay it from there. One statement, so
 * two opens at once cannot lose a count.
 */
export async function recordSearchOpen(
	db: Database,
	p: { workspaceId: string; actorId: string; entityId: string },
): Promise<void> {
	await db.execute(sql`
		INSERT INTO search_opens (workspace_id, actor_id, entity_id, decayed_opens, last_opened_at)
		VALUES (${p.workspaceId}, ${p.actorId}, ${p.entityId}, 1, now())
		ON CONFLICT (workspace_id, actor_id, entity_id) DO UPDATE SET
			decayed_opens = search_opens.decayed_opens
				* power(0.5, extract(epoch from (now() - search_opens.last_opened_at)) / 86400.0
					/ ${FRECENCY_HALF_LIFE_DAYS}::double precision) + 1,
			last_opened_at = now()`)
}
