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

import type { LinkedInMcpInstanceConfig, LinkedInPhase1Verb } from '../lib/linkedin-mcp-context'
import { LINKEDIN_PHASE1_VERBS } from '../lib/linkedin-mcp-context'

/**
 * §2 filter table. Suites map onto verbs; the identity type / messagingEnabled
 * pair decides whether the suite is registered.
 *
 *   - posts+comments+reactions+engagement → every identity.
 *   - messaging                           → personal + messagingEnabled pages.
 *   - connections+invitations             → personal only.
 *   - search + profile lookup             → personal only.
 */
const POSTS_SUITE: readonly LinkedInPhase1Verb[] = [
	'publish_post',
	'read_post_comments',
	'comment_on_post',
	'reply_to_comment',
	'get_post_engagement',
] as const

const MESSAGING_SUITE: readonly LinkedInPhase1Verb[] = [
	'send_message',
	'reply',
	'list_conversations',
	'list_messages',
] as const

const CONNECTIONS_SUITE: readonly LinkedInPhase1Verb[] = [
	'send_connection_request',
	'list_connections',
] as const

const PROFILE_SUITE: readonly LinkedInPhase1Verb[] = ['search_people', 'get_profile'] as const

/**
 * Return the subset of Phase 1 verbs registered on the instance described by
 * `cfg`. Preserves the canonical order from `LINKEDIN_PHASE1_VERBS` so a
 * `tools/list` diff is stable across restarts and reconnects.
 */
export function toolsForIdentity(
	cfg: Pick<LinkedInMcpInstanceConfig, 'identityType' | 'messagingEnabled'>,
): LinkedInPhase1Verb[] {
	const allowed = new Set<LinkedInPhase1Verb>()

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

	// Canonical order — do NOT sort alphabetically; keep spec order for diff stability.
	return LINKEDIN_PHASE1_VERBS.filter((v) => allowed.has(v))
}

export { LINKEDIN_PHASE1_VERBS } from '../lib/linkedin-mcp-context'
export type { LinkedInMcpInstanceConfig, LinkedInPhase1Verb } from '../lib/linkedin-mcp-context'
export { instanceSlug, toolName } from '../lib/linkedin-mcp-context'
