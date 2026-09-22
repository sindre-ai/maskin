/**
 * R11-A · Fan-out registration foundation — the §2 filter table.
 *
 * `toolsForIdentity(cfg)` decides which of the 13 shipped Phase 1 verbs get
 * registered on an MCP instance keyed by identity. Deterministic map, no I/O,
 * no dependencies on the runtime handlers — that keeps the filter unit-testable
 * without a live LinkedIn account and lets the fan-out-shape test in
 * `packages/mcp/src/__tests__/linkedin-fan-out-shape.test.ts` pin the matrix
 * from the spec.
 *
 * The concrete tool registration (zod schemas, handlers hitting the Unipile
 * client) lives in the app that owns the credentials — see
 * `apps/dev/src/lib/integrations/providers/linkedin-unipile/register.ts`'s
 * `registerLinkedInMcpInstance(server, cfg)`.
 */

import type { LinkedInMcpInstanceConfig, LinkedInVerb } from '../lib/linkedin-mcp-context'
import { LINKEDIN_ALL_VERBS } from '../lib/linkedin-mcp-context'

/**
 * §2 filter table. Suites map onto verbs; the identity type / messagingEnabled
 * pair decides whether the suite is registered.
 *
 *   - posts+comments+reactions+engagement → every identity.
 *   - messaging                           → personal + messagingEnabled pages.
 *   - connections+invitations             → personal only.
 *   - search + profile lookup             → personal only.
 *
 * R11-B adds `edit_post` + `delete_post` to POSTS_SUITE — the destructive
 * post CRUD registered per-identity on every instance (personal + page),
 * matching the spec §2 rule that every identity gets the full posts suite.
 */
const POSTS_SUITE: readonly LinkedInVerb[] = [
	'publish_post',
	'edit_post',
	'delete_post',
	'read_post_comments',
	'comment_on_post',
	'reply_to_comment',
	'get_post_engagement',
] as const

const MESSAGING_SUITE: readonly LinkedInVerb[] = [
	'send_message',
	'reply',
	'list_conversations',
	'list_messages',
] as const

const CONNECTIONS_SUITE: readonly LinkedInVerb[] = [
	'send_connection_request',
	'list_connections',
] as const

const PROFILE_SUITE: readonly LinkedInVerb[] = ['search_people', 'get_profile'] as const

/**
 * P3-J · read-only allowlist. The exact set a `readOnly` caller may see per
 * fanned-out identity — the network-reading verbs the [Investor Relations]
 * warm-intro path needs (`list_connections`, `search_people`, `get_profile`)
 * and nothing else. Everything not on this list is filtered out for a
 * read-only caller regardless of what the identity's own §2 suites would
 * otherwise register. Keep this list tight — every verb added here has to be
 * safe for any read-only-tagged agent attached to any workspace identity
 * (per gap-17 in the parent bet).
 *
 * All three are personal-only in the §2 filter table, so on a company_page
 * instance a read-only caller sees an empty tool surface by construction —
 * that is deliberate (page write verbs stay unreachable and there are no
 * page-scoped reads worth exposing to a read-only agent today).
 */
export const LINKEDIN_READ_ONLY_VERBS: readonly LinkedInVerb[] = [
	'list_connections',
	'search_people',
	'get_profile',
] as const

/**
 * Return the subset of R11 verbs (Phase 1 + Phase 2) registered on the
 * instance described by `cfg`. Preserves the canonical order from
 * `LINKEDIN_ALL_VERBS` so a `tools/list` diff is stable across restarts and
 * reconnects — Phase 2 verbs appear at the position their entry in
 * LINKEDIN_ALL_VERBS pins.
 *
 * `opts.readOnly` (P3-J) narrows the identity-side surface to the read-only
 * allowlist above. It is intentionally a second-stage filter over the same
 * §2 output: the identity-side rules stay authoritative for who registers
 * which suite, and the read-only filter only ever REMOVES verbs — never
 * grants a verb an identity would not otherwise carry. Non-read-only callers
 * (the default) get the unchanged surface.
 */
export function toolsForIdentity(
	cfg: Pick<LinkedInMcpInstanceConfig, 'identityType' | 'messagingEnabled'>,
	opts: { readOnly?: boolean } = {},
): LinkedInVerb[] {
	const allowed = new Set<LinkedInVerb>()

	// Posts suite: every identity registers it.
	for (const v of POSTS_SUITE) allowed.add(v)

	// Messaging suite: personal always; pages only when messagingEnabled.
	if (cfg.identityType === 'personal' || cfg.messagingEnabled) {
		for (const v of MESSAGING_SUITE) allowed.add(v)
	}

	// Connections + profile suites: personal-only.
	if (cfg.identityType === 'personal') {
		for (const v of CONNECTIONS_SUITE) allowed.add(v)
		for (const v of PROFILE_SUITE) allowed.add(v)
	}

	if (opts.readOnly) {
		const readOnly = new Set<LinkedInVerb>(LINKEDIN_READ_ONLY_VERBS)
		for (const v of allowed) {
			if (!readOnly.has(v)) allowed.delete(v)
		}
	}

	// Canonical order — do NOT sort alphabetically; keep spec order for diff stability.
	return LINKEDIN_ALL_VERBS.filter((v) => allowed.has(v))
}

export {
	LINKEDIN_PHASE1_VERBS,
	LINKEDIN_PHASE2_VERBS,
	LINKEDIN_ALL_VERBS,
} from '../lib/linkedin-mcp-context'
export type {
	LinkedInMcpInstanceConfig,
	LinkedInPhase1Verb,
	LinkedInPhase2Verb,
	LinkedInVerb,
} from '../lib/linkedin-mcp-context'
export { instanceSlug, toolName } from '../lib/linkedin-mcp-context'
