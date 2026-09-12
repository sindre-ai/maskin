/**
 * P3-B · Symmetric disconnect for `linkedin-unipile`.
 *
 * Wired as the provider's `preDisconnect` hook so that when a workspace
 * disconnects a LinkedIn integration, Maskin also asks Unipile to delete the
 * upstream account — closing the recurring-cost leak from insight (3)
 * "Unipile pile-up on disconnect" (every abandoned disconnect without upstream
 * deletion is silent recurring cost per the Pricing Memo).
 *
 * Best-effort semantics, spelled out because they are load-bearing:
 *   - 404 (already deleted upstream) → log-and-continue.
 *   - Any other non-2xx (4xx / 5xx / network fault) → log the error and STILL
 *     let the local disconnect proceed. The user's disconnect is never
 *     blocked on Unipile's response.
 *   - Missing config or missing account id → warn-and-return. Nothing to
 *     delete, and the operations-layer client already refuses to build without
 *     `UNIPILE_BASE_URL` / `UNIPILE_API_KEY`.
 *
 * Reuse for P3-H (reconnect orphan): the helper is stateless and exported so
 * the reconnect path can call it directly with the orphaned previous account
 * id — same envelope handling, same log line.
 */

import { logger } from '../../../logger'
import type { PreDisconnectContext } from '../../types'
import { classifyLinkedInResponse } from './errors'
import type { LinkedInClient } from './unipile-client'
import { createLinkedInHttpClient } from './unipile-client'

const PROVIDER = 'linkedin-unipile'

/**
 * Test-only seam so the `preDisconnect` path can be exercised without a live
 * Unipile server AND without picking up the operations- or webhook-layer
 * client overrides (those are for the messaging surface and the account.reconnect
 * webhook respectively — a disconnect test does not want its mock consumed by
 * one of those, and vice versa). Reset in `afterEach`.
 */
type DisconnectClientBuilder = () => LinkedInClient

let disconnectClientOverride: DisconnectClientBuilder | null = null

export function __setLinkedInDisconnectClientForTests(
	builder: DisconnectClientBuilder | null,
): void {
	disconnectClientOverride = builder
}

function buildLinkedInClientForDisconnect(): LinkedInClient | null {
	if (disconnectClientOverride) return disconnectClientOverride()
	const baseUrl = process.env.UNIPILE_BASE_URL
	const apiKey = process.env.UNIPILE_API_KEY
	if (!baseUrl || !apiKey) return null
	return createLinkedInHttpClient({ baseUrl, apiKey })
}

/**
 * Ask Unipile to delete the given account. Reused by the disconnect hook and
 * — per the amendment — by P3-H's reconnect-orphan cleanup. Stateless, no
 * side effects beyond the HTTP call + a single structured log line naming the
 * outcome (spec: "structured log line at info level naming the account id +
 * outcome").
 *
 * Returns void; failures are logged and swallowed. Callers that need the
 * outcome can look up the last emitted log line.
 */
export async function deleteUnipileAccountBestEffort(
	client: LinkedInClient,
	accountId: string,
	context: {
		integrationId: string
		workspaceId: string
		reason: 'disconnect' | 'reconnect-orphan'
	},
): Promise<void> {
	try {
		const result = await client.deleteAccount({ account_id: accountId })
		if (result.status >= 200 && result.status < 300) {
			logger.info('linkedin-unipile deleteAccount: deleted upstream', {
				integrationId: context.integrationId,
				workspaceId: context.workspaceId,
				accountId,
				reason: context.reason,
				status: result.status,
			})
			return
		}
		if (result.status === 404) {
			logger.info('linkedin-unipile deleteAccount: already gone upstream (404)', {
				integrationId: context.integrationId,
				workspaceId: context.workspaceId,
				accountId,
				reason: context.reason,
			})
			return
		}
		// Any other non-2xx: log the classification (if any) alongside the raw
		// status so a Sentry / log query can distinguish transient 5xx from a
		// LinkedIn-side auth issue. The local disconnect still proceeds — that's
		// the contract, and it is what stops one Unipile hiccup from stranding
		// users mid-disconnect.
		const code = classifyLinkedInResponse(result.status, result.body)
		logger.warn('linkedin-unipile deleteAccount: upstream error (continuing with disconnect)', {
			integrationId: context.integrationId,
			workspaceId: context.workspaceId,
			accountId,
			reason: context.reason,
			status: result.status,
			code,
		})
	} catch (err) {
		logger.warn('linkedin-unipile deleteAccount: network fault (continuing with disconnect)', {
			integrationId: context.integrationId,
			workspaceId: context.workspaceId,
			accountId,
			reason: context.reason,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * `preDisconnect` hook for the `linkedin-unipile` provider. Wired in
 * `registry.ts` alongside `stopGmailWatch` / `revokeGoogleCalendarGrant`.
 *
 * Reads the Unipile account id from `ctx.externalId` (the R11-A
 * `integrations.external_id` column, set to the Unipile-issued `acc_…` id at
 * connect time), falling back to `credentials.account_id` for rows landed
 * before that column was populated. If neither is present there is nothing
 * to delete upstream — the row is either a `pending` connect that never
 * completed or a pre-R11 shape — and the hook returns silently.
 */
export async function deleteUnipileAccountOnDisconnect(ctx: PreDisconnectContext): Promise<void> {
	const accountId = readAccountId(ctx)
	if (!accountId) {
		logger.info(`${PROVIDER} disconnect: no Unipile account id to delete`, {
			integrationId: ctx.integrationId,
			workspaceId: ctx.workspaceId,
		})
		return
	}
	const client = buildLinkedInClientForDisconnect()
	if (!client) {
		logger.warn(`${PROVIDER} disconnect: Unipile client not configured (skipping deleteAccount)`, {
			integrationId: ctx.integrationId,
			workspaceId: ctx.workspaceId,
			accountId,
		})
		return
	}
	await deleteUnipileAccountBestEffort(client, accountId, {
		integrationId: ctx.integrationId,
		workspaceId: ctx.workspaceId,
		reason: 'disconnect',
	})
}

function readAccountId(ctx: PreDisconnectContext): string | null {
	if (typeof ctx.externalId === 'string' && ctx.externalId.length > 0) return ctx.externalId
	const cred = ctx.credentials as { account_id?: unknown }
	if (typeof cred.account_id === 'string' && cred.account_id.length > 0) return cred.account_id
	return null
}
