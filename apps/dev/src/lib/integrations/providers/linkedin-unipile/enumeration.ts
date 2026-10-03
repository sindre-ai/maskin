/**
 * R11-A · Fan-out registration foundation — Unipile identity enumeration.
 *
 * The connect-callback path in `routes/integrations-linkedin-unipile.ts` and
 * the admin refresh-identities endpoint both need the same three steps from
 * linkedin-mcp-phase2-technical-spec.md §1.4:
 *
 *   1. `unipileClient.getProfile({ identifier: 'me' })` → the connected
 *      human's URN, `public_identifier` (→ `unipile_acc_slug`), display name.
 *   2. `unipileClient.getManagedCompanyPages(account_id)` → admined pages:
 *      URN, `public_identifier` (→ `identity_slug`), display name,
 *      `mailbox_id`, `messaging_enabled`.
 *   3. For each identity (personal + every admined page), call
 *      `registerLinkedInMcpInstance(cfg)`. Idempotent — re-registering the
 *      same `(acc_slug, identity_slug)` replaces the prior instance's
 *      config atomically.
 *
 * This module owns those steps as one function so both callers share the
 * exact same enumeration semantics. It does not touch the DB — the caller
 * persists `unipile_acc_slug` after the enumeration succeeds (that write is
 * transactional with the credential-landing update in the connect-callback
 * path).
 *
 * Client construction is injected via `deps` so tests can pass a fake
 * `LinkedInClient` without going through the operations layer's
 * `__setLinkedInClientForTests` seam (which is scoped to the operations
 * verbs, not the callback path).
 */

import {
	type LinkedInMcpInstanceConfig,
	instanceSlug,
	registerLinkedInMcpInstance,
} from '@maskin/mcp/linkedin'
import { logger } from '../../../logger'
import { LinkedInIntegrationError, classifyLinkedInResponse } from './errors'
import type {
	LinkedInClient,
	LinkedInHttpResult,
	LinkedInListManagedPagesResponse,
	LinkedInManagedPage,
} from './unipile-client'
import { createLinkedInHttpClient } from './unipile-client'

function classify(resp: LinkedInHttpResult<unknown>): LinkedInIntegrationError | null {
	const code = classifyLinkedInResponse(resp.status, resp.body)
	if (!code) return null
	return new LinkedInIntegrationError(code, `LinkedIn returned ${code} on enumeration`, {
		cause: { status: resp.status, body: resp.body },
	})
}

/**
 * Shape the enumeration path returns to callers so the connect-callback can
 * persist the resolved `unipile_acc_slug` inside the same transaction that
 * lands the credential, and the admin refresh endpoint can log the diff.
 */
export interface EnumerationResult {
	/** `linkedin_get_profile('me').public_identifier` — the account slug. */
	unipileAccSlug: string
	/** The MCP instance configs registered as a result of this enumeration. */
	instances: LinkedInMcpInstanceConfig[]
}

export interface EnumerationParams {
	/** LinkedIn's opaque per-account id, from the connect-callback query. */
	unipileAccountId: string
	workspaceId: string
	/** The actor whose credential row the enumeration is landing under. */
	actorId: string
	integrationId: string
}

export interface EnumerationDeps {
	/**
	 * A ready-to-use `LinkedInClient`. Injected so tests can pass a fake
	 * without exporting the operations layer's client-override seam. The
	 * default builder reads `UNIPILE_BASE_URL` + `UNIPILE_API_KEY` from
	 * `process.env` — identical to `buildLinkedInClient` in operations.ts.
	 */
	client?: LinkedInClient
}

function defaultClient(): LinkedInClient {
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
 * Personal LinkedIn's inbox constant. Personal `messagingEnabled` is always
 * true (see spec §2 — pages can be publish-only, the personal identity
 * cannot). Mailbox id null lets the operations layer fall through to
 * `DEFAULT_LINKEDIN_INBOX` on the wire so no page-specific inbox is used.
 */
const PERSONAL_MAILBOX_ID: string | null = null

/**
 * Enumerate identities for a connected linkedin-unipile credential and
 * register one MCP instance per identity. Returns the resolved
 * `unipileAccSlug` so the caller can persist it on the `integrations` row,
 * plus the list of configs that were registered.
 *
 * Throws `LinkedInIntegrationError` on any unrecoverable failure — the
 * connect-callback path swallows and logs so a Unipile hiccup can't leave
 * the credential row un-landed, but the admin refresh path re-throws so a
 * human sees why an intentional refresh failed.
 */
export async function enumerateLinkedInIdentitiesAndRegister(
	params: EnumerationParams,
	deps: EnumerationDeps = {},
): Promise<EnumerationResult> {
	const client = deps.client ?? defaultClient()

	// Step 1 — resolve the connected human's URN + public_identifier.
	const meResp = await client.getProfile({
		account_id: params.unipileAccountId,
		identifier: 'me',
	})
	const meError = classify(meResp)
	if (meError) throw meError
	const me = meResp.body as Record<string, unknown>
	const personSuffix = readString(me, 'provider_id') ?? readString(me, 'id')
	const accSlug = readString(me, 'public_identifier')
	const meDisplay =
		readString(me, 'display_name') ??
		[readString(me, 'first_name'), readString(me, 'last_name')].filter(Boolean).join(' ').trim()
	if (!personSuffix || !accSlug) {
		throw new LinkedInIntegrationError(
			'LINKEDIN_UNAVAILABLE',
			'linkedin_get_profile(me) returned no provider_id/public_identifier — cannot register personal MCP instance',
		)
	}

	// Step 2 — pages the connected member admins.
	const pagesResp = await client.getManagedCompanyPages({
		account_id: params.unipileAccountId,
	})
	const pagesError = classify(pagesResp)
	// A tenant with zero admined pages returns a normal 200 with `data: []`; a
	// 5xx on this call is not fatal for R11-A (personal-only is still a valid
	// registration). Log and continue so the personal instance still lands.
	let pages: LinkedInManagedPage[] = []
	if (pagesError) {
		logger.warn(
			'linkedin-unipile enumeration: getManagedCompanyPages failed, registering personal only',
			{
				integrationId: params.integrationId,
				code: pagesError.code,
			},
		)
	} else {
		const pageBody = pagesResp.body as LinkedInListManagedPagesResponse
		pages = Array.isArray(pageBody.data) ? pageBody.data : []
	}

	const personalCfg: LinkedInMcpInstanceConfig = {
		workspaceId: params.workspaceId,
		actorId: params.actorId,
		integrationId: params.integrationId,
		unipileAccountId: params.unipileAccountId,
		unipileAccSlug: accSlug,
		identityType: 'personal',
		identityUrn: `urn:li:person:${personSuffix}`,
		identitySlug: 'personal',
		displayName: meDisplay || accSlug,
		mailboxId: PERSONAL_MAILBOX_ID,
		messagingEnabled: true,
	}
	registerLinkedInMcpInstance(personalCfg)
	const instances: LinkedInMcpInstanceConfig[] = [personalCfg]

	for (const page of pages) {
		if (!page.object_urn || !page.public_identifier) {
			logger.warn('linkedin-unipile enumeration: page missing urn/public_identifier, skipping', {
				integrationId: params.integrationId,
				pageName: page.name,
			})
			continue
		}
		const pageCfg: LinkedInMcpInstanceConfig = {
			workspaceId: params.workspaceId,
			actorId: params.actorId,
			integrationId: params.integrationId,
			unipileAccountId: params.unipileAccountId,
			unipileAccSlug: accSlug,
			identityType: 'company_page',
			identityUrn: page.object_urn,
			identitySlug: page.public_identifier,
			displayName: page.name || page.public_identifier,
			mailboxId: page.mailbox_id ?? null,
			messagingEnabled: Boolean(page.messaging_enabled),
		}
		registerLinkedInMcpInstance(pageCfg)
		instances.push(pageCfg)
	}

	logger.info('linkedin-unipile enumeration: registered fan-out instances', {
		integrationId: params.integrationId,
		unipileAccSlug: accSlug,
		instanceSlugs: instances.map((c) => instanceSlug(c)),
	})

	return { unipileAccSlug: accSlug, instances }
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
	const v = obj[key]
	return typeof v === 'string' && v.length > 0 ? v : undefined
}
