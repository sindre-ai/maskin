import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { getLinkedInMcpInstancesForIntegration, instanceSlug } from '@maskin/mcp/linkedin'
import { and, eq, isNotNull, ne } from 'drizzle-orm'
import { logger } from '../../../logger'
import type { InstanceSlugMatcher } from '../../mcp-detach'

const PROVIDER = 'linkedin-unipile'

/**
 * Which per-identity MCP endpoint slugs (`linkedin-{unipileAccSlug}-{identitySlug}`)
 * belong to the LinkedIn credential being disconnected, so the agent-config
 * cleanup removes only those entries and leaves every other identity's alone.
 *
 * A slug belongs to this credential when it is registered for it in the
 * in-process registry, or, for a credential whose registry entries are already
 * gone (revoked upstream, process restarted), when it starts with the
 * credential's persisted `linkedin-{unipile_acc_slug}-` prefix. Either way it
 * is protected if another live credential in the workspace owns it: same or
 * longer account slug that prefixes it. The longer-prefix case is real because
 * account slugs contain hyphens (`jo` vs `jo-smith`).
 *
 * Must run BEFORE the registry is deregistered for the credential. Never
 * throws; if the other credentials cannot be read it matches only the slugs the
 * registry names for this credential, so a miss leaves a stale entry rather
 * than deleting a live one.
 */
export async function disconnectedLinkedInSlugMatcher(
	db: Database,
	disconnected: { id: string; workspaceId: string; unipileAccSlug: string | null },
): Promise<InstanceSlugMatcher> {
	const registered = new Set(
		getLinkedInMcpInstancesForIntegration(disconnected.id).map((cfg) => instanceSlug(cfg)),
	)
	const ownPrefix = disconnected.unipileAccSlug ? `linkedin-${disconnected.unipileAccSlug}-` : null

	let otherPrefixes: string[]
	try {
		const others = await db
			.select({ unipileAccSlug: integrations.unipileAccSlug })
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, disconnected.workspaceId),
					eq(integrations.provider, PROVIDER),
					ne(integrations.id, disconnected.id),
					ne(integrations.status, 'revoked'),
					isNotNull(integrations.unipileAccSlug),
				),
			)
		otherPrefixes = others.map((row) => `linkedin-${row.unipileAccSlug}-`)
	} catch (err) {
		logger.warn(
			'linkedin-unipile disconnect: could not read other credentials, detaching only registered slugs',
			{
				integrationId: disconnected.id,
				workspaceId: disconnected.workspaceId,
				error: err instanceof Error ? err.message : String(err),
			},
		)
		return (slug) => registered.has(slug)
	}

	return (slug) => {
		const ours = registered.has(slug) || (ownPrefix !== null && slug.startsWith(ownPrefix))
		if (!ours) return false
		const ownedByAnother = otherPrefixes.some(
			(prefix) => slug.startsWith(prefix) && prefix.length >= (ownPrefix?.length ?? 0),
		)
		return !ownedByAnother
	}
}
