import type { Database } from '@maskin/db'
import { INTEGRATION_STATUS_ACTIVE, integrations } from '@maskin/db/schema'
import { and, asc, eq } from 'drizzle-orm'
import { getProvider } from '../integrations/registry'

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
