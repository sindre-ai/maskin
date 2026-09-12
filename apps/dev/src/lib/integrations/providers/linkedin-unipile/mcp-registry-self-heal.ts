import { getLinkedInMcpInstancesForIntegration, instanceSlug } from '@maskin/mcp/linkedin'
import { INTEGRATION_STATUS_ACTIVE } from '@maskin/db/schema'
import { logger } from '../../../logger'
import { enumerateLinkedInIdentitiesAndRegister } from './enumeration'

/**
 * Self-heal the in-process LinkedIn MCP fan-out registry from the `/mcp`
 * request path. Sibling of `boot-repopulation.ts` — boot fills the registry
 * off the DB at startup, this fills a specific credential's slot inline the
 * first time a `/mcp` request finds it empty (a Coolify redeploy racing a
 * still-starting Unipile, or a boot enumeration that failed and needs a
 * passive retry).
 *
 * Two properties the request path needs that boot doesn't:
 *
 *   - Dedupe in-flight — a burst of `/mcp` requests for the same workspace
 *     must not trigger N concurrent Unipile enumerations for the same
 *     credential. Every waiter awaits the same promise; only the first
 *     one runs the enumeration.
 *
 *   - Negative-cache failures — a Unipile outage that produces a
 *     LINKEDIN_UNAVAILABLE / classifier error must not turn every
 *     subsequent `tools/list` into another Unipile round-trip. The
 *     credential id lives in the negative cache for a short window
 *     (~60s) after a failure; a successful enumeration clears it.
 */

export const SELF_HEAL_NEGATIVE_CACHE_TTL_MS = 60_000

export type SelfHealCredentialRow = {
	id: string
	workspaceId: string
	actorId: string | null
	createdBy: string
	externalId: string | null
	status: string
}

const IN_FLIGHT = new Map<string, Promise<void>>()
const NEGATIVE_CACHE = new Map<string, number>()

export async function selfHealLinkedInMcpCredential(row: SelfHealCredentialRow): Promise<void> {
	if (row.status !== INTEGRATION_STATUS_ACTIVE || !row.externalId) return
	if (getLinkedInMcpInstancesForIntegration(row.id).length > 0) return

	const negativeCachedAt = NEGATIVE_CACHE.get(row.id)
	if (
		negativeCachedAt !== undefined &&
		Date.now() - negativeCachedAt < SELF_HEAL_NEGATIVE_CACHE_TTL_MS
	) {
		return
	}

	const existing = IN_FLIGHT.get(row.id)
	if (existing) {
		await existing
		return
	}

	const unipileAccountId = row.externalId
	const actorId = row.actorId ?? row.createdBy
	const promise = (async () => {
		try {
			const result = await enumerateLinkedInIdentitiesAndRegister({
				unipileAccountId,
				workspaceId: row.workspaceId,
				actorId,
				integrationId: row.id,
			})
			logger.info('linkedin-unipile MCP route: self-healed empty registry entry', {
				integrationId: row.id,
				unipileAccSlug: result.unipileAccSlug,
				instanceSlugs: result.instances.map((c) => instanceSlug(c)),
			})
			NEGATIVE_CACHE.delete(row.id)
		} catch (err) {
			logger.warn('linkedin-unipile MCP route: self-heal enumeration failed', {
				integrationId: row.id,
				error: err instanceof Error ? err.message : String(err),
			})
			NEGATIVE_CACHE.set(row.id, Date.now())
		} finally {
			IN_FLIGHT.delete(row.id)
		}
	})()

	IN_FLIGHT.set(row.id, promise)
	await promise
}

/**
 * Test-only. Resets the in-flight and negative-cache maps between test
 * cases so a leaked entry from one suite cannot make another suite pass
 * or fail.
 */
export function __resetLinkedInMcpSelfHealForTests(): void {
	IN_FLIGHT.clear()
	NEGATIVE_CACHE.clear()
}
