import type { Database } from '@maskin/db'
import { INTEGRATION_STATUS_ACTIVE, integrations } from '@maskin/db/schema'
import { instanceSlug } from '@maskin/mcp/linkedin'
import { and, eq, isNotNull } from 'drizzle-orm'
import { logger } from '../../../logger'
import { enumerateLinkedInIdentitiesAndRegister } from './enumeration'

/**
 * Boot-time repopulation of the in-process LinkedIn MCP registry from every
 * active `linkedin-unipile` credential in the DB. Runs once, from
 * `apps/dev/src/index.ts` at startup.
 *
 * Why this exists — the registry is a process-local Map (see
 * `packages/mcp/src/lib/registry.ts`). Every Coolify redeploy of apps/dev
 * wipes it, and until R11-A neither the connect-callback nor any of the
 * self-heal touchpoints ran at boot. The result was that after every
 * deploy, `tools/list` on the LinkedIn MCP for a workspace with an active
 * credential returned zero tools until the user manually reconnected — and
 * a reconnect minted a fresh Unipile account, silently piling up €4.90/mo
 * subscription lines.
 *
 * The single-request-cost properties this preserves:
 *
 *   - Idempotent — every registration path in R11 is atomic-replace keyed
 *     on `(integrationId, identitySlug)` (see `registerLinkedInMcpInstance`
 *     in the registry). A boot repopulation that races with an in-flight
 *     connect-callback for the same credential merges without a duplicate.
 *
 *   - Best-effort per row — a Unipile failure for one credential logs a
 *     warning and never blocks boot or other credentials. Boot may not
 *     have every credential registered when `tools/list` first arrives;
 *     that gap is what the self-heal path in
 *     `integrations-linkedin-unipile-mcp.ts` covers.
 *
 *   - Bounded concurrency — a tenant with many credentials cannot
 *     serialise boot on Unipile latency, but the fan-out is bounded so a
 *     runaway workspace cannot flood Unipile either.
 */
const PROVIDER = 'linkedin-unipile'
const BOOT_REPOPULATION_CONCURRENCY = 4

export async function repopulateLinkedInMcpRegistryOnBoot(db: Database): Promise<void> {
	const rows = await db
		.select({
			id: integrations.id,
			workspaceId: integrations.workspaceId,
			actorId: integrations.actorId,
			createdBy: integrations.createdBy,
			externalId: integrations.externalId,
		})
		.from(integrations)
		.where(
			and(
				eq(integrations.provider, PROVIDER),
				eq(integrations.status, INTEGRATION_STATUS_ACTIVE),
				isNotNull(integrations.externalId),
			),
		)

	if (rows.length === 0) {
		logger.info('linkedin-unipile boot repopulation: no active credentials to repopulate')
		return
	}

	logger.info('linkedin-unipile boot repopulation: starting', { credentials: rows.length })

	let cursor = 0
	const worker = async () => {
		while (cursor < rows.length) {
			const idx = cursor++
			const row = rows[idx]
			if (!row?.externalId) continue
			try {
				const result = await enumerateLinkedInIdentitiesAndRegister({
					unipileAccountId: row.externalId,
					workspaceId: row.workspaceId,
					actorId: row.actorId ?? row.createdBy,
					integrationId: row.id,
				})
				logger.info('linkedin-unipile boot repopulation: registered fan-out instances', {
					integrationId: row.id,
					unipileAccSlug: result.unipileAccSlug,
					instanceSlugs: result.instances.map((c) => instanceSlug(c)),
				})
			} catch (err) {
				logger.warn('linkedin-unipile boot repopulation: enumeration failed for credential', {
					integrationId: row.id,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(BOOT_REPOPULATION_CONCURRENCY, rows.length) }, worker),
	)

	logger.info('linkedin-unipile boot repopulation: done', { credentials: rows.length })
}
