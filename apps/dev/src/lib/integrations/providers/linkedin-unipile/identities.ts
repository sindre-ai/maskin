import type { Database } from '@maskin/db'
import { INTEGRATION_STATUS_ACTIVE, integrations } from '@maskin/db/schema'
import { getLinkedInMcpInstancesForIntegration, instanceSlug } from '@maskin/mcp/linkedin'
import { and, eq } from 'drizzle-orm'
import { selfHealLinkedInMcpCredential } from './mcp-registry-self-heal'

export interface LinkedInIdentity {
	instanceSlug: string
	displayName: string
	identityType: 'personal' | 'company_page'
	identitySlug: string
	unipileAccSlug: string
	integrationId: string
}

/**
 * Every live LinkedIn identity (personal profile or admined page) in a
 * workspace, sorted by display name. Reads the same fan-out registry the
 * `/mcp/:instanceSlug` endpoint serves from, self-healing it first, so what is
 * offered here always matches what the MCP server would answer.
 */
export async function listLinkedInIdentities(
	db: Database,
	workspaceId: string,
): Promise<LinkedInIdentity[]> {
	const credentialRows = await db
		.select({
			id: integrations.id,
			workspaceId: integrations.workspaceId,
			actorId: integrations.actorId,
			createdBy: integrations.createdBy,
			externalId: integrations.externalId,
			status: integrations.status,
		})
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, 'linkedin-unipile'),
				eq(integrations.status, INTEGRATION_STATUS_ACTIVE),
			),
		)

	await Promise.all(credentialRows.map(selfHealLinkedInMcpCredential))

	return credentialRows
		.flatMap((row) => getLinkedInMcpInstancesForIntegration(row.id))
		.map((cfg) => ({
			instanceSlug: instanceSlug(cfg),
			displayName: cfg.displayName,
			identityType: cfg.identityType,
			identitySlug: cfg.identitySlug,
			unipileAccSlug: cfg.unipileAccSlug,
			integrationId: cfg.integrationId,
		}))
		.sort((a, b) => a.displayName.localeCompare(b.displayName))
}
