import type { Database } from '@maskin/db'
import { INTEGRATION_STATUS_ACTIVE, type Integration, integrations } from '@maskin/db/schema'
import { and, asc, eq, isNull } from 'drizzle-orm'

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
 *   actor-scoped surface. Pass `{ fallbackToAnyActor: true }` to widen the
 *   read to any connected identity in the workspace — see below.
 * - For any other provider: matches on `actor_id IS NULL`, preserving the
 *   pre-0065 workspace-scoped semantics regardless of what the caller passes
 *   for `actorId`. This makes it safe to thread an actorId through every call
 *   site — the allow-list is what decides whether it's honored.
 *
 * In both cases `status = 'active'` is required, so pending, errored or
 * revoked connections never leak to a caller expecting live credentials.
 * `'active'` is the vocabulary every write path in routes/integrations.ts
 * uses and every other reader filters on — this helper must not invent its
 * own status value, or it silently matches nothing.
 */
export interface IntegrationCredentialOptions {
	/**
	 * For an actor-scoped provider, fall back to ANY connected identity in the
	 * workspace when the calling actor has none of its own.
	 *
	 * Actor-scoping exists so a workspace can hold several connected accounts
	 * for one provider — one per human — and so the LinkedIn add-on can bill
	 * per identity. It was never meant to mean "only the human who connected
	 * may use it": agents are actors too and never go through a connect flow,
	 * so a strict read makes the credential unreachable from exactly the place
	 * it is meant to be used (an agent's MCP tool call). Same expectation
	 * every other provider sets — one person connects Gmail, every agent in
	 * the workspace can use it.
	 *
	 * Callers that must resolve one specific human's account (billing counts,
	 * the reconnect surface) leave this off and get the strict behaviour.
	 */
	fallbackToAnyActor?: boolean
}

export async function getIntegrationCredential(
	db: Database,
	workspaceId: string,
	provider: string,
	actorId: string | null,
	options: IntegrationCredentialOptions = {},
): Promise<Integration | null> {
	const requiresActor = actorScopedProviders.has(provider)
	if (requiresActor && !actorId && !options.fallbackToAnyActor) return null
	const scope = and(
		eq(integrations.workspaceId, workspaceId),
		eq(integrations.provider, provider),
		eq(integrations.status, INTEGRATION_STATUS_ACTIVE),
	)
	if (requiresActor && actorId) {
		const [own] = await db
			.select()
			.from(integrations)
			.where(and(scope, eq(integrations.actorId, actorId)))
			.limit(1)
		if (own) return own
		if (!options.fallbackToAnyActor) return null
	}
	if (requiresActor) {
		// Deterministic pick: oldest connected identity wins. Sending as a
		// human is not something to decide by whichever row Postgres happens to
		// return, and an unordered read would silently change whose LinkedIn an
		// agent posts from as soon as a second person connects.
		const [any] = await db
			.select()
			.from(integrations)
			.where(scope)
			.orderBy(asc(integrations.createdAt))
			.limit(1)
		return any ?? null
	}
	const rows = await db
		.select()
		.from(integrations)
		.where(and(scope, isNull(integrations.actorId)))
		.limit(1)
	return rows[0] ?? null
}
