/**
 * R11-A · Fan-out registration foundation — per-instance MCP config shape.
 *
 * Every connected LinkedIn identity (the human profile plus each admined
 * company page) becomes ITS OWN MCP instance registered as
 * `linkedin-{unipileAccSlug}-{identitySlug}`. The tools registered on that
 * instance are pre-scoped to the identity at register-time via this config
 * blob — nothing about "which identity is sending" is ever a per-call input
 * again. See linkedin-mcp-phase2-technical-spec.md §2 and R11 items 1-3 in §10.
 *
 * `identityUrn` is resolved ONCE at register-time from the Unipile enumeration
 * (`getProfile('me')` for personal, `getManagedCompanyPages` for pages) and
 * stored on the immutable per-instance config. The per-call handlers pull it
 * from this blob rather than making a per-call Unipile round-trip.
 *
 * Path is dictated by the R11-A spec so callers can import from a package that
 * does not need to know anything about `apps/dev`, drizzle, or the Unipile
 * client wiring — kept dependency-free on purpose.
 */

export type LinkedInIdentityType = 'personal' | 'company_page'

export interface LinkedInMcpInstanceConfig {
	/** The Maskin workspace the credential row belongs to. */
	workspaceId: string
	/**
	 * The Maskin actor who owns the LinkedIn credential (the human who ran the
	 * connect flow). Not the *caller* of the tool — the caller is any actor in
	 * the workspace that has this MCP instance attached.
	 */
	actorId: string
	/** `integrations.id` — the credential row this instance is scoped to. */
	integrationId: string
	/**
	 * LinkedIn `account_id` (Unipile's opaque per-account id). Same value across
	 * every instance derived from the same credential row.
	 */
	unipileAccountId: string
	/**
	 * `linkedin_get_profile('me').public_identifier` — e.g. `sebastianbille`.
	 * Persisted on `integrations.unipile_acc_slug` at connect-time. Deterministic
	 * across reconnects of the same LinkedIn account.
	 */
	unipileAccSlug: string
	/** `personal` for the human profile, `company_page` for admined pages. */
	identityType: LinkedInIdentityType
	/**
	 * The URN LinkedIn uses to attribute a post/comment/reaction:
	 *   - personal → `urn:li:person:<opaque>`
	 *   - page     → `urn:li:organization:<numeric>`
	 * Handlers inject this on the Unipile wire (as `poster_urn`,
	 * `commenter_urn`, `sender_urn`) so agents never carry it in their args.
	 */
	identityUrn: string
	/**
	 * The identity half of the instance slug:
	 *   - personal → literal `personal`
	 *   - page     → page's `public_identifier` (e.g. `maskinio`) — NOT the
	 *                numeric page id, so the slug stays human-readable.
	 */
	identitySlug: string
	/** Human-facing name templated into every tool description at register-time. */
	displayName: string
	/**
	 * Unipile mailbox id for messaging-enabled pages. `null` for
	 * `messagingEnabled: false` pages. Personal identities always carry the
	 * `CLASSIC_PRIMARY` inbox constant defined in the Unipile client.
	 */
	mailboxId: string | null
	/**
	 * Pages: from Unipile's `getManagedCompanyPages` (a page can be
	 * publish-only). Personal: always `true`.
	 * Drives the §2 filter — messaging suite verbs are only registered on
	 * instances where this is `true`.
	 */
	messagingEnabled: boolean
}

/**
 * The 13 SHIPPED Phase 1 verbs re-namespaced under
 * `linkedin-{unipileAccSlug}-{identitySlug}__{verb}` by R11-A. Anything not in
 * this list belongs to R11-B / R11-C / a later R11 follow-on.
 */
export const LINKEDIN_PHASE1_VERBS = [
	'publish_post',
	'send_message',
	'reply',
	'list_conversations',
	'list_messages',
	'list_connections',
	'search_people',
	'comment_on_post',
	'reply_to_comment',
	'read_post_comments',
	'get_post_engagement',
	'send_connection_request',
	'get_profile',
] as const

export type LinkedInPhase1Verb = (typeof LINKEDIN_PHASE1_VERBS)[number]

/**
 * Phase 2 verbs added by R11-B: destructive post CRUD (`edit_post`,
 * `delete_post`). Kept in their own list rather than folded into
 * `LINKEDIN_PHASE1_VERBS` so R11-A's registrar work stays reviewable against
 * the 13-verb baseline it named — the R11 fan-out sees the union.
 *
 * `edit_post` and `delete_post` are BOTH keyed on `post_id` and belong to the
 * posts suite in the §2 filter table (personal + every page instance —
 * see `packages/mcp/src/linkedin/register.ts`). They do NOT accept an
 * `attachments` field: LinkedIn v2 freezes attachments at publish, and edit
 * only mutates text + comment permissions.
 */
export const LINKEDIN_PHASE2_VERBS = ['edit_post', 'delete_post'] as const

export type LinkedInPhase2Verb = (typeof LINKEDIN_PHASE2_VERBS)[number]

/**
 * Union of every verb R11 registers per-identity — Phase 1 + Phase 2. The
 * canonical order is Phase 1 first (preserving the diff-stable order the
 * baseline pinned), then Phase 2 appended.
 */
export const LINKEDIN_ALL_VERBS = [...LINKEDIN_PHASE1_VERBS, ...LINKEDIN_PHASE2_VERBS] as const

export type LinkedInVerb = (typeof LINKEDIN_ALL_VERBS)[number]

/**
 * Compose the instance slug from a config blob. Callers should NOT re-derive
 * this format ad-hoc — the same value has to appear on the instance name, in
 * the tool prefix, and in every log line that talks about the instance.
 */
export function instanceSlug(
	cfg: Pick<LinkedInMcpInstanceConfig, 'unipileAccSlug' | 'identitySlug'>,
): string {
	return `linkedin-${cfg.unipileAccSlug}-${cfg.identitySlug}`
}

/**
 * Compose a per-identity tool name. Kept alongside `instanceSlug` so the two
 * halves of the fan-out contract sit in one file and drift together if they
 * drift at all.
 */
export function toolName(
	cfg: Pick<LinkedInMcpInstanceConfig, 'unipileAccSlug' | 'identitySlug'>,
	verb: LinkedInVerb,
): string {
	return `${instanceSlug(cfg)}__${verb}`
}
