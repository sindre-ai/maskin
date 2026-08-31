import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'

/**
 * The Unipile-backed LinkedIn provider — the only provider that today bills
 * as a per-connected-identity add-on on top of the workspace subscription.
 * Matches the `provider` value Task 2's Unipile connect callback writes into
 * the `integrations` row on `CREATION_SUCCESS`.
 */
export const LINKEDIN_IDENTITY_PROVIDER = 'linkedin-unipile'

/**
 * €29/connected identity/month — Sebk-locked (LinkedIn MCP pricing memo,
 * bet §Pricing). Displayed at this exact literal on the plan surface; the
 * Stripe Product + Price configured under `STRIPE_PRICE_LINKEDIN_IDENTITY`
 * MUST be created at €29/month (EUR) to match. Stored in EUR cents so it
 * lines up with Stripe's minor-unit API for later checkout wiring.
 */
export const LINKEDIN_IDENTITY_UNIT_PRICE_EUR_CENTS = 2900

/** The row the plan surface renders when the add-on is active for a workspace. */
export interface LinkedInIdentityAddonLine {
	/** Number of connected `linkedin-unipile` credentials on the workspace. */
	count: number
	/** Per-connected-identity monthly price, EUR cents. */
	unit_price_eur_cents: number
	/** count × unit_price_eur_cents, EUR cents. */
	monthly_total_eur_cents: number
}

/**
 * Counts connected LinkedIn identities for a workspace. Filters on
 * `status = 'connected'` to match what Task 2's Unipile hosted-wizard callback
 * writes on `CREATION_SUCCESS`; rows in other states (`pending` during the
 * wizard round-trip, `revoked` after a disconnect) do NOT count toward the
 * add-on.
 *
 * Reads only from the pre-refactor `integrations` schema — no dependency on
 * `actor_id` (which lands in Task 1's PR #1466). Each row already represents
 * one connected identity per the existing `(workspace_id, provider, external_id)`
 * uniqueness guard.
 */
export async function getConnectedLinkedInIdentityCount(
	db: Database,
	workspaceId: string,
): Promise<number> {
	const rows = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, LINKEDIN_IDENTITY_PROVIDER),
				eq(integrations.status, 'connected'),
			),
		)
	return rows[0]?.n ?? 0
}

/**
 * Builds the add-on line the plan surface renders — or returns `null` when
 * the add-on should be hidden. The route treats `null` as "render nothing",
 * so keeping the branching here means the response-assembly seam stays flat.
 *
 * Hidden when the flag is off (regardless of count) OR when the workspace has
 * zero connected identities (regardless of flag): both cases mean the buyer
 * is not paying for LinkedIn connectivity this period.
 */
export function resolveLinkedInIdentityAddon(input: {
	connectedCount: number
	flagOn: boolean
}): LinkedInIdentityAddonLine | null {
	if (!input.flagOn) return null
	if (input.connectedCount <= 0) return null
	return {
		count: input.connectedCount,
		unit_price_eur_cents: LINKEDIN_IDENTITY_UNIT_PRICE_EUR_CENTS,
		monthly_total_eur_cents: input.connectedCount * LINKEDIN_IDENTITY_UNIT_PRICE_EUR_CENTS,
	}
}
