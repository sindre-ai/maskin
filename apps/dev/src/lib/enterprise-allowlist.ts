import type { Database } from '@maskin/db'
import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { logger } from './logger'

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Actor IDs exempt from every plan-tier limit (seat cap, ownership cap, $
 * hard cap, credit debiting) on every workspace they bill-own. Read from
 * MASKIN_ENTERPRISE_ACTOR_IDS (comma-separated UUIDs) rather than a code
 * constant, so the account IDs never appear in the diff/PR history. See
 * PR #970.
 */
export function parseEnterpriseActorIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
	const raw = env.MASKIN_ENTERPRISE_ACTOR_IDS
	if (!raw) return new Set()
	const ids = new Set<string>()
	for (const entry of raw.split(',')) {
		const id = entry.trim()
		if (!id) continue
		if (!UUID_SHAPE.test(id)) {
			logger.warn('MASKIN_ENTERPRISE_ACTOR_IDS rejected malformed entry', {
				entryLength: id.length,
			})
			continue
		}
		ids.add(id.toLowerCase())
	}
	return ids
}

export function isEnterpriseActor(
	actorId: string | null | undefined,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (!actorId) return false
	return parseEnterpriseActorIds(env).has(actorId.toLowerCase())
}

/**
 * True when `workspaceId`'s billing owner is an enterprise actor. Short-
 * circuits before the DB round trip whenever the allowlist is empty (every
 * deployment that hasn't set MASKIN_ENTERPRISE_ACTOR_IDS), so this adds no
 * overhead by default.
 */
export async function isEnterpriseWorkspace(
	db: Pick<Database, 'select'>,
	workspaceId: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
	const allowlist = parseEnterpriseActorIds(env)
	if (allowlist.size === 0) return false
	const [row] = await db
		.select({ billingOwnerId: workspaces.billingOwnerId })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!row?.billingOwnerId) return false
	return allowlist.has(row.billingOwnerId.toLowerCase())
}
