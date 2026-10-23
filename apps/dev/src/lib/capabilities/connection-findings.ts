/**
 * Decisions for the two connection-level finding kinds the capability scan
 * records beside the tool-level ones: needs_reconnect and available_not_attached.
 *
 * Pure, no I/O. The scanner supplies the holder sets (from holders.ts, the only
 * module that answers "who can use this source") and the stored credentials;
 * this file only decides what kind of finding that adds up to. It never reads
 * agent tool config, never writes anything, and never names an agent: the
 * findings carry integration and scope names only.
 */

import { INTEGRATION_STATUS_ACTIVE } from '@maskin/db/schema'
import { integrationScopeGaps } from '../integrations/scope-drift'
import type { ProviderConfig } from '../integrations/types'

export type ToolAddedResolution =
	| { kind: 'tool_added' }
	| { kind: 'needs_reconnect'; missingScopes: string[] }

/**
 * What a new tool on a source should be recorded as.
 *
 * Returns null when nobody holds the source: a tool nobody can use is stored in
 * the snapshot but never flagged, and a reconnect would unlock nothing for
 * anyone. Otherwise a stored token that lacks a scope the provider config now
 * requires turns the finding into needs_reconnect, because the new tool is not
 * usable until an admin reconnects. Sources with no provider config (the
 * built-in tools) have no token to check and stay tool_added.
 */
export function resolveToolAddedKind(input: {
	config: ProviderConfig | undefined
	credentials: { scope?: unknown; userScope?: unknown }
	holders: readonly string[]
}): ToolAddedResolution | null {
	if (input.holders.length === 0) return null
	if (!input.config) return { kind: 'tool_added' }

	const { missing, needsReconnect } = integrationScopeGaps(input.config, input.credentials)
	if (needsReconnect) return { kind: 'needs_reconnect', missingScopes: missing }
	return { kind: 'tool_added' }
}

export interface IntegrationRow {
	/** Source key from sources.ts: integration:{provider}:{integrationId}. */
	sourceKey: string
	provider: string
	integrationId: string
	status: string
}

export interface NotAttachedFinding {
	kind: 'available_not_attached'
	sourceKey: string
	provider: string
	integrationId: string
}

/**
 * Active integrations that declare an MCP server, are not auto-injected, and
 * that no agent holds.
 *
 * Connecting such an integration alone gives no agent any tools (the case the
 * list_integration_providers description warns about). Auto-injected providers
 * are excluded because every agent already has them. `holdersBySource` is keyed
 * by source key (integration:{provider}:{integrationId}) and comes from
 * holders.ts; a source missing from the map has no holders.
 */
export function findAvailableNotAttached(input: {
	integrations: readonly IntegrationRow[]
	configFor: (provider: string) => ProviderConfig | undefined
	holdersBySource: ReadonlyMap<string, readonly string[]>
}): NotAttachedFinding[] {
	const findings: NotAttachedFinding[] = []
	for (const integration of input.integrations) {
		if (integration.status !== INTEGRATION_STATUS_ACTIVE) continue

		const mcp = input.configFor(integration.provider)?.mcp
		if (!mcp?.server || mcp.autoInject) continue

		if ((input.holdersBySource.get(integration.sourceKey)?.length ?? 0) > 0) continue

		findings.push({
			kind: 'available_not_attached',
			sourceKey: integration.sourceKey,
			provider: integration.provider,
			integrationId: integration.integrationId,
		})
	}
	return findings
}
