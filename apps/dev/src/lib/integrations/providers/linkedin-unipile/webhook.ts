/**
 * R11-C · unipile.account.updated webhook handler + client builder.
 *
 * Lives in the provider directory (not the route) so the same entry point
 * is reused by:
 *
 *   - `POST /api/integrations/linkedin-unipile/webhook` — the primary
 *     path Unipile fires on page-admin churn.
 *   - The 403 safety-net in `operations.ts` — when a page-scoped call
 *     403s with `error_code: 'page_admin_revoked'`, we enqueue an
 *     `account.updated`-style re-enumeration for the credential. In
 *     practice "enqueue" is an inline await on the same handler.
 *
 * Kept dependency-light: this module resolves the credential from the
 * database, decrypts it, and hands off to the diff engine in
 * `./fan-out.ts`. Nothing about the webhook transport (headers, secret,
 * status codes) lives here — that stays in the route.
 */

import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { decrypt } from '../../../crypto'
import { logger } from '../../../logger'
import { LinkedInIntegrationError } from './errors'
import { type FanOutDiff, reEnumerateAndSyncLinkedInInstances } from './fan-out'
import type { LinkedInClient } from './unipile-client'
import { createLinkedInHttpClient } from './unipile-client'

const PROVIDER = 'linkedin-unipile'

/**
 * Test-only seam so the webhook route + the 403 safety-net can be
 * exercised without a live Unipile server. Reset in `afterEach`. Kept in
 * this module (not `operations.ts`'s override) so the two seams stay
 * independent — a webhook test does not want its mock consumed by an
 * unrelated operations-level call.
 */
type WebhookClientBuilder = () => LinkedInClient

let webhookClientOverride: WebhookClientBuilder | null = null

export function __setLinkedInWebhookClientForTests(builder: WebhookClientBuilder | null): void {
	webhookClientOverride = builder
}

/**
 * Build the Unipile client the webhook + safety-net use. Same env-var
 * shape as the operations-layer client so a deployment misconfiguration
 * surfaces the same way for both. `UNIPILE_BASE_URL` must NOT include
 * `/v2` — the client owns the path prefix.
 */
export function buildLinkedInClientForWebhook(): LinkedInClient {
	if (webhookClientOverride) return webhookClientOverride()
	const baseUrl = process.env.UNIPILE_BASE_URL
	const apiKey = process.env.UNIPILE_API_KEY
	if (!baseUrl || !apiKey) {
		throw new LinkedInIntegrationError(
			'LINKEDIN_UNAVAILABLE',
			'LinkedIn client is not configured (missing UNIPILE_BASE_URL or UNIPILE_API_KEY)',
		)
	}
	return createLinkedInHttpClient({ baseUrl, apiKey })
}

/**
 * Look up the active `linkedin-unipile` row(s) for a given Unipile
 * account id and re-enumerate identities against each.
 *
 * A Unipile account can be attached to more than one Maskin workspace at
 * once (the same LinkedIn user might connect their account from two
 * workspaces they belong to); every attached credential row is
 * re-enumerated independently so per-workspace registries stay in sync.
 * This mirrors the "matching integrations" fan-out the generic webhook
 * route does for Slack multi-workspace installs.
 *
 * Returns a summary of every credential the event was applied to.
 * Failures on one row do NOT abort the others — the webhook route is
 * idempotent by contract, so a partial success is better than a full
 * rollback that leaves half the workspaces stale.
 */
export async function handleUnipileAccountUpdated(
	db: Database,
	client: LinkedInClient,
	unipileAccountId: string,
): Promise<{
	appliedTo: Array<{
		integrationId: string
		workspaceId: string
		diff: FanOutDiff | { error: string }
	}>
}> {
	const rows = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.provider, PROVIDER),
				eq(integrations.externalId, unipileAccountId),
				eq(integrations.status, 'active'),
			),
		)

	if (rows.length === 0) {
		logger.info('linkedin-unipile account.updated: no matching credential rows', {
			unipileAccountId,
		})
		return { appliedTo: [] }
	}

	const appliedTo: Array<{
		integrationId: string
		workspaceId: string
		diff: FanOutDiff | { error: string }
	}> = []

	for (const row of rows) {
		let credentials: { account_id?: string } = {}
		try {
			credentials = JSON.parse(decrypt(row.credentials)) as { account_id?: string }
		} catch (err) {
			logger.warn('linkedin-unipile account.updated: failed to decrypt credentials', {
				integrationId: row.id,
				error: err instanceof Error ? err.message : String(err),
			})
			appliedTo.push({
				integrationId: row.id,
				workspaceId: row.workspaceId,
				diff: { error: 'CREDENTIAL_UNREADABLE' },
			})
			continue
		}
		if (!credentials.account_id || !row.unipileAccSlug) {
			// A credential landed pre-R11 has account_id but no unipileAccSlug
			// yet — the first webhook fires the R11-A `updateIntegrationAccSlug`
			// side-effect that fills it in. Skip diffing until then.
			logger.info('linkedin-unipile account.updated: skipping row without unipile_acc_slug', {
				integrationId: row.id,
			})
			appliedTo.push({
				integrationId: row.id,
				workspaceId: row.workspaceId,
				diff: { error: 'MISSING_UNIPILE_ACC_SLUG' },
			})
			continue
		}
		// `actor_id` is nullable on integrations (workspace-scoped providers keep
		// it NULL); linkedin-unipile is in the actor-scoped allow list so it is
		// always set, but fall back to `created_by` for safety.
		const actorId = row.actorId ?? row.createdBy
		const diff = await reEnumerateAndSyncLinkedInInstances(client, {
			workspaceId: row.workspaceId,
			actorId,
			integrationId: row.id,
			unipileAccountId: credentials.account_id,
			unipileAccSlug: row.unipileAccSlug,
		})
		if ('error' in diff) {
			appliedTo.push({
				integrationId: row.id,
				workspaceId: row.workspaceId,
				diff: { error: diff.error.code },
			})
		} else {
			appliedTo.push({
				integrationId: row.id,
				workspaceId: row.workspaceId,
				diff,
			})
		}
	}

	return { appliedTo }
}
