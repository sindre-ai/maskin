import type { Database } from '@maskin/db'
import { INTEGRATION_STATUS_ACTIVE, integrations } from '@maskin/db/schema'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { decrypt } from '../crypto'
import { getProvider } from '../integrations/registry'
import type { ProviderConfig } from '../integrations/types'
import { logger } from '../logger'
import type { IntegrationRow } from './connection-findings'

export const BUILTIN_SOURCE_KEY = 'maskin:builtin'

/**
 * How a source is probed. Never a model, never a container.
 * - builtin: the tools const in packages/mcp (class A)
 * - in_process: an MCP server the API itself serves, built in memory (class B)
 * - hosted_http: an external HTTP MCP server, one authenticated tools/list (class C)
 * - stdio_spec: a stdio server that is NOT spawned; only its spec hash is recorded
 */
export type ProbeKind = 'builtin' | 'in_process' | 'hosted_http' | 'stdio_spec'

export interface CapabilitySource {
	/** maskin:builtin or integration:{provider}:{integrationId}. */
	key: string
	/** Entity id on the snapshot rows: the integration id, the workspace id for built-in. */
	entityId: string
	probe: ProbeKind
	provider?: string
	integrationId?: string
}

// Providers whose MCP server the API itself serves. Their declared server url
// points back at this API, so they are built in memory, never fetched.
const IN_PROCESS_PROVIDERS = new Set(['slack', 'google-meet', 'linkedin-unipile'])

export function integrationSourceKey(provider: string, integrationId: string): string {
	return `integration:${provider}:${integrationId}`
}

/**
 * The tool sources of one workspace: Maskin built-in plus one per active
 * integration whose provider has an MCP surface we can answer for. Providers
 * with no MCP surface (gmail, linear, ...) are not sources.
 */
export async function enumerateSources(
	db: Database,
	workspaceId: string,
): Promise<CapabilitySource[]> {
	const sources: CapabilitySource[] = [
		{ key: BUILTIN_SOURCE_KEY, entityId: workspaceId, probe: 'builtin' },
	]
	const rows = await db
		.select({ id: integrations.id, provider: integrations.provider })
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.status, INTEGRATION_STATUS_ACTIVE),
			),
		)
		.orderBy(asc(integrations.createdAt), asc(integrations.id))

	for (const row of rows) {
		let mcp: ReturnType<typeof getProvider>['config']['mcp']
		try {
			mcp = getProvider(row.provider).config.mcp
		} catch {
			continue
		}
		if (!mcp) continue
		const base = {
			key: integrationSourceKey(row.provider, row.id),
			entityId: row.id,
			provider: row.provider,
			integrationId: row.id,
		}
		if (IN_PROCESS_PROVIDERS.has(row.provider)) {
			sources.push({ ...base, probe: 'in_process' })
		} else if (mcp.server?.type === 'http') {
			sources.push({ ...base, probe: 'hosted_http' })
		} else if (row.provider === 'github') {
			sources.push({ ...base, probe: 'stdio_spec' })
		}
	}
	return sources
}

/** A provider's config, or undefined for one this build no longer registers. */
export function providerConfigOf(provider: string): ProviderConfig | undefined {
	try {
		return getProvider(provider).config
	} catch {
		return undefined
	}
}

/**
 * Every active integration of the workspace, whether or not it is a probed
 * source. available_not_attached needs this wider list: gmail, google-calendar
 * and linear declare an MCP server but are not probed, and they are exactly the
 * ones that give an agent nothing until someone attaches them.
 */
export async function enumerateActiveIntegrations(
	db: Database,
	workspaceId: string,
): Promise<IntegrationRow[]> {
	const rows = await db
		.select({ id: integrations.id, provider: integrations.provider, status: integrations.status })
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.status, INTEGRATION_STATUS_ACTIVE),
			),
		)
		.orderBy(asc(integrations.createdAt), asc(integrations.id))
	return rows.map((row) => ({
		sourceKey: integrationSourceKey(row.provider, row.id),
		provider: row.provider,
		integrationId: row.id,
		status: row.status,
	}))
}

/** What a stored token was granted. Scope strings only; nothing else leaves this file. */
export interface GrantedScopes {
	scope?: string
	userScope?: string
}

/**
 * The scope strings of each integration's stored token, by integration id.
 * The decrypted blob is read here and dropped: only the two scope strings are
 * returned. An integration whose blob cannot be read (almost always an
 * encryption-key rotation) is left out, which the scope check treats as unknown.
 */
export async function loadGrantedScopes(
	db: Database,
	workspaceId: string,
	integrationIds: readonly string[],
): Promise<Map<string, GrantedScopes>> {
	const granted = new Map<string, GrantedScopes>()
	if (integrationIds.length === 0) return granted
	const rows = await db
		.select({ id: integrations.id, credentials: integrations.credentials })
		.from(integrations)
		.where(
			and(eq(integrations.workspaceId, workspaceId), inArray(integrations.id, [...integrationIds])),
		)
	for (const row of rows) {
		if (typeof row.credentials !== 'string') continue
		try {
			const parsed = JSON.parse(decrypt(row.credentials)) as Record<string, unknown>
			granted.set(row.id, {
				scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
				userScope: typeof parsed.userScope === 'string' ? parsed.userScope : undefined,
			})
		} catch (err) {
			logger.warn('Capability scan could not read an integration credential', {
				workspaceId,
				integrationId: row.id,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}
	return granted
}
