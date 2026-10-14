import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { deregisterLinkedInMcpInstancesForIntegration } from '@maskin/mcp/linkedin'
import { eq } from 'drizzle-orm'
import { decrypt } from '../crypto'
import { recordEvent } from '../events/record-event'
import { LINKEDIN_IDENTITY_PROVIDER } from '../linkedin-addon'
import { syncLinkedInAddonQuantity } from '../linkedin-addon-billing'
import { logger } from '../logger'
import { detachProviderMcpServers } from './mcp-detach'
import { getProvider } from './registry'
import type { StoredCredentials } from './types'

type IntegrationRow = typeof integrations.$inferSelect

/**
 * Disconnect one integration row: provider preDisconnect (revoke), flip the row
 * to 'revoked', and the follow-ups that hang off the flip. This is the body of
 * DELETE /api/integrations/:id, shared so a bulk disconnect runs exactly the
 * same steps per row. The caller has already proven the row belongs to the
 * workspace it is acting in.
 */
export async function disconnectIntegrationRow(
	db: Database,
	existing: IntegrationRow,
	actorId: string,
): Promise<void> {
	// Provider-specific cleanup before flipping status to 'revoked'. Runs while
	// credentials are still readable so the provider can call its remote API
	// (e.g. Gmail's users.stop) with a valid token. Provider implementations
	// are responsible for swallowing errors so disconnect always proceeds.
	//
	// Credentials are decrypted lazily (only when a preDisconnect hook exists) and
	// only for non-pending integrations — pending rows have credentials: '' because
	// the OAuth flow was never completed and there is nothing to revoke at the provider.
	try {
		const resolved = getProvider(existing.provider)
		if (resolved.preDisconnect && existing.status !== 'pending') {
			const credentials: StoredCredentials = JSON.parse(decrypt(existing.credentials))
			await resolved.preDisconnect({
				db,
				integrationId: existing.id,
				workspaceId: existing.workspaceId,
				credentials,
				externalId: existing.externalId,
			})
		}
	} catch (err) {
		logger.warn(`preDisconnect failed for provider ${existing.provider}`, {
			integrationId: existing.id,
			error: err instanceof Error ? err.message : String(err),
		})
	}

	await db.transaction(async (tx) => {
		await tx
			.update(integrations)
			.set({ status: 'revoked', updatedAt: new Date() })
			.where(eq(integrations.id, existing.id))

		await recordEvent(tx, {
			workspaceId: existing.workspaceId,
			actorId,
			action: 'updated',
			entityType: 'integration',
			entityId: existing.id,
			data: { status: 'revoked', reason: 'user_disconnected' },
		})
	})

	// Drop the disconnected identity off the $49 add-on. Runs after the status
	// flip commits, because the sync recomputes quantity from the count of
	// `active` rows — running it first would still count the row being
	// revoked and leave the customer billed for it. Quantity changes carry
	// `proration_behavior: 'none'`, so the identity stays paid for through the
	// end of the period it was connected in.
	if (existing.provider === LINKEDIN_IDENTITY_PROVIDER) {
		await syncLinkedInAddonQuantity(db, existing.workspaceId)
		// P3-C · Drop every fan-out MCP instance owned by this credential row
		// from the in-process registry, so `tools/list` on the linkedin-unipile
		// MCP endpoint no longer surfaces this integration's tools. Belt to the
		// per-call `integrations.status` gate's braces (operations.ts preamble):
		// the gate keeps a wrong (revoked) credential from reaching Unipile even
		// on a race, while the deregister keeps a disconnected identity from
		// appearing to still be there in the tool list. Uses the same code path
		// R11-C wired for the Unipile-initiated `account.disconnect` webhook.
		const dropped = deregisterLinkedInMcpInstancesForIntegration(existing.id)
		if (dropped > 0) {
			logger.info('Deregistered LinkedIn fan-out instances on disconnect', {
				workspaceId: existing.workspaceId,
				integrationId: existing.id,
				dropped,
			})
		}
	}

	// Agents hold a copied snapshot of the provider's MCP server config, which
	// outlives the credential behind it. Left in place, the agent boots with
	// the server attached, advertises its tools, and fails every call — so it
	// reports a broken platform instead of a missing connection.
	await detachProviderMcpServers(db, existing.workspaceId, existing.provider, actorId)
}
