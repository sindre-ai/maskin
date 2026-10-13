import { type ScopeGrant, integrations } from '@maskin/db/schema'
import { sql } from 'drizzle-orm'

/**
 * Providers whose connect flow writes one workspace grant. The same two
 * providers migration 0088 backfills. Per-actor tightening for LinkedIn is a
 * later product call, so this is workspace-wide on purpose. Any other provider
 * keeps the empty default and stays fail-closed until something grants it.
 */
const WORKSPACE_GRANTED_PROVIDERS = new Set(['google-meet', 'linkedin-unipile'])

/** Grants for a row being inserted by a connect flow. */
export function scopeGrantsOnInsert(provider: string): ScopeGrant[] {
	return WORKSPACE_GRANTED_PROVIDERS.has(provider) ? [{ kind: 'workspace' }] : []
}

/**
 * Spread into the .set() of an UPDATE that reconnects an existing row: fills in
 * the workspace grant only when scope_grants is still empty, in one statement,
 * and never overwrites grants that are already there. Empty for other providers.
 */
export function scopeGrantsOnReconnect(
	provider: string,
): { scopeGrants: ReturnType<typeof sql> } | Record<string, never> {
	if (!WORKSPACE_GRANTED_PROVIDERS.has(provider)) return {}
	return {
		scopeGrants: sql`CASE WHEN ${integrations.scopeGrants} = '[]'::jsonb THEN '[{"kind":"workspace"}]'::jsonb ELSE ${integrations.scopeGrants} END`,
	}
}
