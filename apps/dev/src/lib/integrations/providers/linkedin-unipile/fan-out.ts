/**
 * R11-C · Shared enumeration + diff engine for the LinkedIn (Unipile) fan-out.
 *
 * Two callers, one path:
 *
 *   - `unipile.account.updated` webhook handler in
 *     `apps/dev/src/routes/integrations-linkedin-unipile.ts` — fires when
 *     LinkedIn signals page-admin churn (new page granted, page renamed,
 *     admin revoked, `messaging_enabled` flipped).
 *   - 403 safety-net in `operations.ts` — when a page-scoped call 403s
 *     with `error_code: 'page_admin_revoked'`, deregister THAT specific
 *     instance inline and enqueue a re-enumeration for the credential so
 *     the loop sees the full new identity set on the next call (spec §1.4
 *     last paragraph).
 *
 * Path (spec §1.4 steps 1-2):
 *   1. Call `getProfile({ identifier: 'me' })` on the Unipile client — the
 *      connected human's own profile.
 *   2. Call `getManagedCompanyPages({ account_id })` — every page this
 *      account currently administers.
 *   3. Shape each enumerated identity into a `LinkedInMcpInstanceConfig`
 *      keyed by `linkedin-{unipileAccSlug}-{identitySlug}`.
 *   4. Diff against `getLinkedInMcpInstancesForIntegration(integrationId)`.
 *   5. Register the additions via `registerLinkedInMcpInstance(cfg)`
 *      (idempotent — spec §1.4 says a page rename produces a
 *      deregister-then-register pair, so re-register replaces atomically),
 *      and deregister the removals via
 *      `deregisterLinkedInMcpInstance(cfg)`.
 *
 * The diff is returned alongside the mutations that were applied so the
 * webhook handler can log a one-line before/after summary. Tests use the
 * return shape to assert the diff without needing to inspect the registry.
 */

import type { LinkedInMcpInstanceConfig } from '@maskin/mcp/linkedin'
import {
	deregisterLinkedInMcpInstance,
	getLinkedInMcpInstancesForIntegration,
	instanceSlug,
	registerLinkedInMcpInstance,
} from '@maskin/mcp/linkedin'
import { logger } from '../../../logger'
import { LinkedInIntegrationError, classifyLinkedInResponse } from './errors'
import type { LinkedInClient, LinkedInManagedPage } from './unipile-client'

/**
 * The identity fields the fan-out cares about, extracted from an
 * enumeration response. Kept separate from `LinkedInMcpInstanceConfig`
 * because construction of the full config needs the workspace / actor /
 * integration ids too, which the caller has and the enumeration does
 * not.
 */
export type EnumeratedIdentity =
	| {
			type: 'personal'
			identityUrn: string
			identitySlug: string
			displayName: string
			mailboxId: string
			messagingEnabled: true
	  }
	| {
			type: 'company_page'
			identityUrn: string
			identitySlug: string
			displayName: string
			mailboxId: string | null
			messagingEnabled: boolean
	  }

/**
 * The LinkedIn primary inbox constant. Kept here rather than pulled from
 * `unipile-client.ts` because both callers of the fan-out (webhook route
 * + operations) already depend on this module, and the personal instance
 * is always registered against `CLASSIC_PRIMARY`.
 */
const CLASSIC_PRIMARY_INBOX = 'CLASSIC_PRIMARY'

/**
 * Pull `provider_id` off a Unipile record with the field-name variance
 * observed in the wild: some tenants send `provider_id`, some send `id`,
 * and both need to route to the URN. Returns `null` when neither is
 * present as a non-empty string.
 */
function readProviderId(rec: Record<string, unknown>): string | null {
	const providerId = typeof rec.provider_id === 'string' ? rec.provider_id : null
	if (providerId && providerId.length > 0) return providerId
	const id = typeof rec.id === 'string' ? rec.id : null
	if (id && id.length > 0) return id
	return null
}

function readString(rec: Record<string, unknown>, key: string): string | null {
	const v = rec[key]
	return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Extract the personal identity from a `getProfile({ identifier: 'me' })`
 * response. Returns `null` when the response is missing the fields we
 * need — the webhook caller treats that as an unrecoverable enumeration
 * failure and skips the diff rather than partial-registering a broken
 * personal instance.
 */
export function readPersonalIdentity(
	body: Record<string, unknown>,
): Extract<EnumeratedIdentity, { type: 'personal' }> | null {
	const providerId = readProviderId(body)
	const publicId = readString(body, 'public_identifier')
	if (!providerId || !publicId) return null
	const displayName =
		readString(body, 'display_name') ??
		[readString(body, 'first_name'), readString(body, 'last_name')]
			.filter((s): s is string => Boolean(s))
			.join(' ')
			.trim()
	return {
		type: 'personal',
		identityUrn: `urn:li:person:${providerId}`,
		identitySlug: 'personal',
		displayName: displayName || publicId,
		mailboxId: CLASSIC_PRIMARY_INBOX,
		messagingEnabled: true,
	}
}

/**
 * Extract a page identity from one element of a
 * `getManagedCompanyPages({ account_id })` response.
 *
 * `public_identifier` is required — it is the identity-slug half of the
 * MCP instance slug. A page without one is silently dropped (would
 * yield `linkedin-{acc}-` which is not a valid instance name); this
 * matches R11-A's §2 filter shape.
 */
export function readPageIdentity(
	page: LinkedInManagedPage & Record<string, unknown>,
): Extract<EnumeratedIdentity, { type: 'company_page' }> | null {
	const providerId = readProviderId(page)
	const publicId = readString(page, 'public_identifier')
	if (!providerId || !publicId) return null
	const messagingEnabled = page.messaging_enabled === true
	const mailboxId = messagingEnabled ? (page.mailbox_id ?? null) : null
	return {
		type: 'company_page',
		identityUrn: `urn:li:organization:${providerId}`,
		identitySlug: publicId,
		displayName: readString(page, 'name') ?? publicId,
		mailboxId,
		messagingEnabled,
	}
}

/**
 * Run enumeration steps 1-2 (spec §1.4) against a Unipile client and
 * return the identity set. Throws a `LinkedInIntegrationError` if either
 * upstream call fails classifiably; the caller decides whether to swallow
 * (webhook: log and skip) or bubble (operations layer: safety-net path
 * is best-effort — a failed re-enum still lets the original 403 surface).
 */
export async function enumerateLinkedInIdentities(
	client: LinkedInClient,
	accountId: string,
): Promise<EnumeratedIdentity[]> {
	const identities: EnumeratedIdentity[] = []

	const meResult = await client.getProfile({ account_id: accountId, identifier: 'me' })
	const meCode = classifyLinkedInResponse(meResult.status, meResult.body)
	if (meCode !== null) {
		throw new LinkedInIntegrationError(
			meCode,
			`LinkedIn enumeration (getProfile me) failed: ${meCode}`,
			{ httpStatus: meResult.status },
		)
	}
	const personal = readPersonalIdentity((meResult.body ?? {}) as Record<string, unknown>)
	if (personal) identities.push(personal)

	const pagesResult = await client.getManagedCompanyPages({ account_id: accountId })
	const pagesCode = classifyLinkedInResponse(pagesResult.status, pagesResult.body)
	if (pagesCode !== null) {
		throw new LinkedInIntegrationError(
			pagesCode,
			`LinkedIn enumeration (getManagedCompanyPages) failed: ${pagesCode}`,
			{ httpStatus: pagesResult.status },
		)
	}
	const pagesBody = (pagesResult.body ?? {}) as Record<string, unknown>
	const pageArr = Array.isArray(pagesBody.data) ? (pagesBody.data as unknown[]) : []
	for (const raw of pageArr) {
		if (raw && typeof raw === 'object') {
			const pageIdentity = readPageIdentity(raw as LinkedInManagedPage & Record<string, unknown>)
			if (pageIdentity) identities.push(pageIdentity)
		}
	}

	return identities
}

/**
 * Base fields the caller supplies once per credential; the diff engine
 * combines these with each enumerated identity to build the full
 * `LinkedInMcpInstanceConfig`. Kept typed rather than an object spread so
 * a missing field is a compile error.
 */
export type CredentialCoords = {
	workspaceId: string
	actorId: string
	integrationId: string
	unipileAccountId: string
	unipileAccSlug: string
}

/**
 * Build the full config for one enumerated identity, given the shared
 * credential coordinates. Exported so tests can pin the config shape
 * without spinning up the diff engine.
 */
export function buildInstanceConfig(
	base: CredentialCoords,
	identity: EnumeratedIdentity,
): LinkedInMcpInstanceConfig {
	return {
		workspaceId: base.workspaceId,
		actorId: base.actorId,
		integrationId: base.integrationId,
		unipileAccountId: base.unipileAccountId,
		unipileAccSlug: base.unipileAccSlug,
		identityType: identity.type,
		identityUrn: identity.identityUrn,
		identitySlug: identity.identitySlug,
		displayName: identity.displayName,
		mailboxId: identity.mailboxId,
		messagingEnabled: identity.messagingEnabled,
	}
}

/** Result of one diff pass. Sorted by slug so log lines / tests are stable. */
export type FanOutDiff = {
	registered: LinkedInMcpInstanceConfig[]
	deregistered: LinkedInMcpInstanceConfig[]
	unchanged: LinkedInMcpInstanceConfig[]
}

/**
 * Diff the enumerated identity set against the currently-registered
 * instances for this credential, apply the mutations, and return the
 * diff for logging / test assertions.
 *
 * `registered` includes both first-time adds AND re-registers driven by
 * a `messagingEnabled` flip or a display-name change on an existing
 * identity. The registry's re-register is atomic, so a re-register with
 * changed fields replaces the stored config in one step (the invariant
 * that makes a page rename correct: rename changes the `identitySlug`,
 * which is a deregister-then-register pair).
 */
export function diffAndSyncLinkedInInstances(
	base: CredentialCoords,
	enumerated: EnumeratedIdentity[],
): FanOutDiff {
	const desired = enumerated.map((id) => buildInstanceConfig(base, id))
	const desiredBySlug = new Map<string, LinkedInMcpInstanceConfig>()
	for (const cfg of desired) desiredBySlug.set(instanceSlug(cfg), cfg)

	const current = getLinkedInMcpInstancesForIntegration(base.integrationId)
	const currentBySlug = new Map<string, LinkedInMcpInstanceConfig>()
	for (const cfg of current) currentBySlug.set(instanceSlug(cfg), cfg)

	const registered: LinkedInMcpInstanceConfig[] = []
	const deregistered: LinkedInMcpInstanceConfig[] = []
	const unchanged: LinkedInMcpInstanceConfig[] = []

	for (const [slug, cfg] of desiredBySlug) {
		const existing = currentBySlug.get(slug)
		if (existing && configEquals(existing, cfg)) {
			unchanged.push(cfg)
			continue
		}
		registerLinkedInMcpInstance(cfg)
		registered.push(cfg)
	}
	for (const [slug, cfg] of currentBySlug) {
		if (!desiredBySlug.has(slug)) {
			deregisterLinkedInMcpInstance(cfg)
			deregistered.push(cfg)
		}
	}

	const sortBySlug = (a: LinkedInMcpInstanceConfig, b: LinkedInMcpInstanceConfig) =>
		instanceSlug(a).localeCompare(instanceSlug(b))
	registered.sort(sortBySlug)
	deregistered.sort(sortBySlug)
	unchanged.sort(sortBySlug)
	return { registered, deregistered, unchanged }
}

/**
 * Structural equality for two configs on the fields the register step
 * cares about. Fields the registry ignores (workspace / actor / integration
 * ids) are compared too so a callsite passing the wrong context surfaces
 * as a re-register rather than a silent no-op.
 */
function configEquals(a: LinkedInMcpInstanceConfig, b: LinkedInMcpInstanceConfig): boolean {
	return (
		a.workspaceId === b.workspaceId &&
		a.actorId === b.actorId &&
		a.integrationId === b.integrationId &&
		a.unipileAccountId === b.unipileAccountId &&
		a.unipileAccSlug === b.unipileAccSlug &&
		a.identityType === b.identityType &&
		a.identityUrn === b.identityUrn &&
		a.identitySlug === b.identitySlug &&
		a.displayName === b.displayName &&
		a.mailboxId === b.mailboxId &&
		a.messagingEnabled === b.messagingEnabled
	)
}

/**
 * End-to-end enumerate + diff + apply. Both the webhook and the 403
 * safety-net route through this so the semantics stay in one place. On
 * enumeration failure the diff is skipped — best-effort by design (a
 * failed re-enum must not mask the 403 the caller is already about to
 * surface).
 */
export async function reEnumerateAndSyncLinkedInInstances(
	client: LinkedInClient,
	base: CredentialCoords,
): Promise<FanOutDiff | { error: LinkedInIntegrationError }> {
	let enumerated: EnumeratedIdentity[]
	try {
		enumerated = await enumerateLinkedInIdentities(client, base.unipileAccountId)
	} catch (err) {
		if (err instanceof LinkedInIntegrationError) {
			logger.warn('linkedin-unipile re-enumeration failed', {
				integrationId: base.integrationId,
				code: err.code,
			})
			return { error: err }
		}
		throw err
	}
	const diff = diffAndSyncLinkedInInstances(base, enumerated)
	if (diff.registered.length > 0 || diff.deregistered.length > 0) {
		logger.info('linkedin-unipile re-enumeration diff applied', {
			integrationId: base.integrationId,
			registered: diff.registered.map((c) => instanceSlug(c)),
			deregistered: diff.deregistered.map((c) => instanceSlug(c)),
			unchanged: diff.unchanged.length,
		})
	}
	return diff
}
