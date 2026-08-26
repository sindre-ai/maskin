import type { Database } from '@maskin/db'
import { type Integration, integrations } from '@maskin/db/schema'
import { and, eq, isNull } from 'drizzle-orm'

/**
 * Providers whose credentials are actor-scoped: a workspace can hold multiple
 * connected accounts for the same provider, one per actor. The single source
 * of truth for this decision — the schema treats `integrations.actor_id` as
 * a plain nullable column, so nothing at the DB layer prevents a caller from
 * storing an actor-scoped credential for a provider not listed here. Adding
 * to this set is a conscious call: it changes the uniqueness contract from
 * "one connection per workspace" to "one connection per (workspace, actor)"
 * for that provider, and every reader that fetches its credentials must
 * supply a real actorId.
 */
export const actorScopedProviders = new Set<string>(['linkedin-unipile'])

/**
 * Fetches the connected credential row for a (workspace, provider, actor)
 * triple, gated by the actor-scoped-provider allow-list.
 *
 * - For a provider IN `actorScopedProviders`: matches on the exact
 *   `actor_id = actorId`. Passing `actorId = null` for a scoped provider is a
 *   caller bug (there is no workspace-shared row to fall back to) and returns
 *   null — the read cannot silently promote a workspace-scoped row into an
 *   actor-scoped surface.
 * - For any other provider: matches on `actor_id IS NULL`, preserving the
 *   pre-0065 workspace-scoped semantics regardless of what the caller passes
 *   for `actorId`. This makes it safe to thread an actorId through every call
 *   site — the allow-list is what decides whether it's honored.
 *
 * In both cases `status = 'connected'` is required, so pending or failed
 * connections never leak to a caller expecting live credentials.
 */
export async function getIntegrationCredential(
	db: Database,
	workspaceId: string,
	provider: string,
	actorId: string | null,
): Promise<Integration | null> {
	const requiresActor = actorScopedProviders.has(provider)
	if (requiresActor && !actorId) return null
	const rows = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, provider),
				eq(integrations.status, 'connected'),
				requiresActor ? eq(integrations.actorId, actorId as string) : isNull(integrations.actorId),
			),
		)
		.limit(1)
	return rows[0] ?? null
}
