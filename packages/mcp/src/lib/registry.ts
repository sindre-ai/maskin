/**
 * R11-A · Fan-out registration foundation — the in-process MCP instance registry.
 *
 * Every connected LinkedIn identity (the human profile plus each admined
 * company page) is a separate MCP instance keyed by
 * `linkedin-{unipileAccSlug}-{identitySlug}`. The connect-callback path in
 * `apps/dev/src/routes/integrations-linkedin-unipile.ts` enumerates identities
 * once per credential (see linkedin-mcp-phase2-technical-spec.md §1.4) and
 * calls `registerLinkedInMcpInstance(cfg)` for each — this file is where those
 * configs land so the MCP request handler (which builds a server per HTTP
 * request) can look them up without a per-request Unipile round-trip.
 *
 * The registry is intentionally an in-memory Map:
 *   - The identity-derived fields (URN, mailbox id, messaging flag) are cheap
 *     to re-enumerate — the admin refresh-identities endpoint plus the
 *     `unipile.account.updated` webhook (R11-C) both re-run enumeration and
 *     re-populate this map.
 *   - The one datum that has to survive a process restart is
 *     `integrations.unipile_acc_slug`, which is persisted on the credential row
 *     itself (see migration 0069). Everything else is derivable on demand from
 *     Unipile plus that slug.
 *   - Adding a table for it would force every reader in the app to know about
 *     R11's identity model even though the shape can change between R11-A and
 *     R11-C — the map is cheaper to iterate on.
 *
 * Instances are keyed by `(integrationId, identitySlug)`. Re-registering the
 * same key replaces the prior config atomically; that is the load-bearing
 * idempotency contract of `registerLinkedInMcpInstance` from spec §1.4 step 4.
 * `integrationId` (not workspaceId) is the key because a single workspace can
 * hold more than one connected LinkedIn credential — one credential per
 * (workspace, actor) is the shape today.
 */

import type { LinkedInMcpInstanceConfig } from './linkedin-mcp-context'
import { instanceSlug } from './linkedin-mcp-context'

/**
 * Instances live under `integrationId → identitySlug → cfg`.
 *
 * A nested Map (rather than a single composite-key Map) keeps two lookups
 * fast without a second index: "give me every instance for THIS credential"
 * (the /mcp request path) and "give me every instance for THIS workspace"
 * (the admin refresh path, which reads `integrationId → workspaceId` from the
 * DB and then filters this map).
 */
const REGISTRY: Map<string, Map<string, LinkedInMcpInstanceConfig>> = new Map()

/**
 * Register (or replace) one MCP instance's config. Idempotent: calling with
 * the same `(integrationId, identitySlug)` overwrites the prior cfg in place,
 * matching the "atomic replace" contract in §1.4 step 4. Returns the cfg back
 * so the caller can log the resolved instance slug in one line.
 */
export function registerLinkedInMcpInstance(
	cfg: LinkedInMcpInstanceConfig,
): LinkedInMcpInstanceConfig {
	let byIdentity = REGISTRY.get(cfg.integrationId)
	if (!byIdentity) {
		byIdentity = new Map()
		REGISTRY.set(cfg.integrationId, byIdentity)
	}
	byIdentity.set(cfg.identitySlug, cfg)
	return cfg
}

/**
 * Drop every registered instance for a credential row — used by the admin
 * refresh-identities path so a page the connected member no longer admins
 * disappears from `tools/list` on the next request. Returns the number of
 * instances that were dropped so callers can log it.
 */
export function deregisterLinkedInMcpInstancesForIntegration(integrationId: string): number {
	const byIdentity = REGISTRY.get(integrationId)
	if (!byIdentity) return 0
	const count = byIdentity.size
	REGISTRY.delete(integrationId)
	return count
}

/**
 * R11-C · Drop exactly one instance keyed by `(integrationId, identitySlug)`
 * on the cfg. Used by the `unipile.account.updated` webhook diff (a page
 * that disappeared from enumeration is deregistered without touching sibling
 * pages on the same credential) and by the 403 safety-net path (the
 * specific page-scoped call that faulted is dropped inline; the credential's
 * other identities keep serving).
 *
 * Idempotent — returns `true` when an instance was removed, `false` when
 * the slug was not registered. Never touches `github-*` (kept in a separate
 * registry surface); never touches other LinkedIn instances on the same
 * credential (different `identitySlug` → different key).
 */
export function deregisterLinkedInMcpInstance(cfg: LinkedInMcpInstanceConfig): boolean {
	const byIdentity = REGISTRY.get(cfg.integrationId)
	if (!byIdentity) return false
	const removed = byIdentity.delete(cfg.identitySlug)
	if (removed && byIdentity.size === 0) REGISTRY.delete(cfg.integrationId)
	return removed
}

/**
 * All instances registered under one credential. The `/mcp` request handler
 * reads this per HTTP request and hands the configs to
 * `registerLinkedInMcpInstance(server, cfg)` in the app-side registrar to
 * build tools for the calling actor's connected identities.
 */
export function getLinkedInMcpInstancesForIntegration(
	integrationId: string,
): LinkedInMcpInstanceConfig[] {
	const byIdentity = REGISTRY.get(integrationId)
	if (!byIdentity) return []
	return Array.from(byIdentity.values())
}

/**
 * Every currently-registered instance across every credential, keyed by
 * instance slug (`linkedin-{acc}-{identity}`). Tests and observability
 * surfaces read this — production code should prefer the by-integration
 * lookup above.
 */
export function listLinkedInMcpInstances(): Map<string, LinkedInMcpInstanceConfig> {
	const flat = new Map<string, LinkedInMcpInstanceConfig>()
	for (const byIdentity of REGISTRY.values()) {
		for (const cfg of byIdentity.values()) {
			flat.set(instanceSlug(cfg), cfg)
		}
	}
	return flat
}

/**
 * Test-only. Not exported from the package barrel — callers should reach in
 * from a `__tests__` module. Resets the registry between test cases so a
 * leaked entry from one suite cannot make another suite pass or fail.
 */
export function __resetLinkedInMcpRegistryForTests(): void {
	REGISTRY.clear()
}
