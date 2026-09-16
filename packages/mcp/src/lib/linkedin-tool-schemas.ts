/**
 * R11-B · Canonical Zod input shapes for the four content/community verbs the
 * fan-out (R11-A) registers per-identity: `__publish_post`, `__send_message`,
 * `__edit_post`, `__delete_post`.
 *
 * Kept in a package rather than `apps/dev` so R11-A's concrete per-identity
 * registrar (which lands on the R11-A branch) and the current flat MCP shell
 * in `apps/dev/src/lib/integrations/providers/linkedin-unipile/mcp-server.ts`
 * both import the SAME shapes. Two definitions of the same input schema is
 * the fastest way to drift on the fields agents build for.
 *
 * Every shape is returned in two forms:
 *
 *   - `xxxInputShape` — a `Record<string, ZodType>` suitable for MCP's
 *     `registerTool({ inputSchema: … })`, which does NOT accept a full Zod
 *     object. The MCP SDK rewraps this into `z.object` internally.
 *   - `xxxInputSchema` — the full Zod object (with any `.refine` clauses)
 *     for operation-layer validation. `.refine` is deliberately kept OFF the
 *     tool-registration shape, because refining at the tool boundary means an
 *     agent's mistake surfaces as a Zod formatting error rather than the
 *     domain error the operation layer would prefer to render (e.g. "at
 *     least one of text or can_comment is required").
 *
 * NONE of these schemas accept a `post_as`, `comment_as`, `react_as`, or
 * `send_as` field. R11-A pre-scopes the acting identity at register-time
 * (`LinkedInMcpInstanceConfig.identityUrn`) — nothing about which identity is
 * posting is ever a per-call input again. A test asserts these fields do not
 * leak back in on any of the four schemas.
 */

import { z } from 'zod'
import { linkedinAttachmentsArraySchema } from './linkedin-attachments'

/**
 * Character limits are LinkedIn's, not ours. The 3000-char post body limit is
 * enforced both here and again by LinkedIn — the wire error is
 * LINKEDIN_POST_TOO_LONG (see linkedin-unipile/errors.ts).
 */
export const LINKEDIN_POST_MAX_CHARS = 3000

/** LinkedIn's messaging body limit is 8000 chars, per the Unipile v2 reference. */
export const LINKEDIN_MESSAGE_MAX_CHARS = 8000

/**
 * `can_comment` values LinkedIn's v2 permit — same three values LinkedIn's own
 * compose UI presents. `no_one` == "off"; LinkedIn v2 accepts the underscored
 * form on the wire.
 */
export const LINKEDIN_CAN_COMMENT_VALUES = ['anyone', 'connections', 'no_one'] as const

export type LinkedInCanComment = (typeof LINKEDIN_CAN_COMMENT_VALUES)[number]

// ── __publish_post ─────────────────────────────────────────────────────────
//
// Personal-profile or per-page publish. Identity is pre-scoped by the
// register-time `LinkedInMcpInstanceConfig.identityUrn`; `attachments` is the
// only structural difference from Phase 1's `text`-only publish shape. No
// `post_as` field: R11-A stopped taking identity as a per-call arg.

export const publishPostInputShape = {
	text: z
		.string()
		.min(1)
		.max(LINKEDIN_POST_MAX_CHARS)
		.describe(
			`Post body. Max ${LINKEDIN_POST_MAX_CHARS} chars — LinkedIn hard limit. Plain text; newlines allowed; @mentions and hashtags render as-is on LinkedIn.`,
		),
	attachments: linkedinAttachmentsArraySchema
		.optional()
		.describe(
			'Optional attachments. LinkedIn accepts up to 9 images together (carousel) OR exactly one non-image (video or document). Mixed types are rejected.',
		),
} as const

export const publishPostInputSchema = z.object(publishPostInputShape)
export type PublishPostInput = z.infer<typeof publishPostInputSchema>

// ── __send_message ─────────────────────────────────────────────────────────
//
// Messaging attachment surface. `send_mode` is meaningful HERE (native vs
// file) but NOT on publish attachments — LinkedIn's feed rendering wins on
// posts regardless of the request field. Identity, again, is pre-scoped by
// register-time.

export const sendMessageInputShape = {
	recipient_urn: z
		.string()
		.min(1)
		.describe(
			'Provider id of the recipient member, as returned in `recipient_urn` from listing conversations — an opaque LinkedIn member id like "ACoAAAxxxxxBxxxxxxxxxxxxxxxxxxxxxxxxxxx". Pass verbatim. NOT a "urn:li:person:..." URN.',
		),
	body: z
		.string()
		.min(1)
		.max(LINKEDIN_MESSAGE_MAX_CHARS)
		.describe(
			`Plain-text message body. Max ${LINKEDIN_MESSAGE_MAX_CHARS} chars (LinkedIn hard limit). No HTML; newlines allowed.`,
		),
	attachments: linkedinAttachmentsArraySchema
		.optional()
		.describe(
			"Optional attachments. `send_mode` on each entry selects native inline vs Unipile-hosted file link; unset defaults to LinkedIn's per-type behaviour.",
		),
	idempotency_key: z
		.string()
		.min(1)
		.max(128)
		.describe(
			'Client-generated key that deduplicates retries. If the server has seen this key from the same identity within the TTL window, the prior response is replayed and no second LinkedIn send occurs.',
		),
} as const

export const sendMessageInputSchema = z.object(sendMessageInputShape)
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>

// ── __edit_post ────────────────────────────────────────────────────────────
//
// LinkedIn v2 only lets an author edit the text and the comment-permission of
// a post they already published; attachments are FROZEN at publish, so the
// schema does not accept an `attachments` field. `.refine` requires at least
// one of `text` or `can_comment` — a call with neither is a no-op and would
// waste a Unipile round-trip.

export const editPostInputShape = {
	post_id: z
		.string()
		.min(1)
		.describe(
			'Post id of a post THIS identity has published. LinkedIn returns POST_NOT_FOUND if the id refers to a post authored by a different identity.',
		),
	text: z
		.string()
		.min(1)
		.max(LINKEDIN_POST_MAX_CHARS)
		.optional()
		.describe(
			`New post body. Max ${LINKEDIN_POST_MAX_CHARS} chars — LinkedIn hard limit. LinkedIn shows an "edited" marker on the post after this call.`,
		),
	can_comment: z
		.enum(LINKEDIN_CAN_COMMENT_VALUES)
		.optional()
		.describe(
			'Who may comment on the post: "anyone", "connections", or "no_one" (comments disabled).',
		),
} as const

export const editPostInputSchema = z
	.object(editPostInputShape)
	.refine(
		(v) => v.text !== undefined || v.can_comment !== undefined,
		'At least one of text or can_comment is required.',
	)

export type EditPostInput = z.infer<typeof editPostInputSchema>

// ── __delete_post ──────────────────────────────────────────────────────────
//
// Irreversible on LinkedIn's side. LinkedIn returns 204 on success; a SECOND
// call for the same post id returns POST_NOT_FOUND, which the operations
// layer treats as a successful no-op (spec §5). No `attachments` field —
// nothing to say beyond the post id.

export const deletePostInputShape = {
	post_id: z
		.string()
		.min(1)
		.describe(
			'Post id of a post THIS identity has published. Irreversible; a second call with the same id returns POST_NOT_FOUND (treated as a successful no-op).',
		),
} as const

export const deletePostInputSchema = z.object(deletePostInputShape)
export type DeletePostInput = z.infer<typeof deletePostInputSchema>

/**
 * Union of the four input shapes, keyed by verb name (without the
 * `linkedin-…-…__` prefix R11-A applies). Exported so a test can iterate the
 * full set and assert no forbidden field (`post_as` / `comment_as` /
 * `react_as` / `send_as`) has leaked back in on any of them.
 */
export const LINKEDIN_R11_INPUT_SHAPES = {
	publish_post: publishPostInputShape,
	send_message: sendMessageInputShape,
	edit_post: editPostInputShape,
	delete_post: deletePostInputShape,
} as const

/** Fields R11-A pre-scopes at register-time and therefore MUST NOT appear on any per-call input. */
export const FORBIDDEN_IDENTITY_PER_CALL_FIELDS = [
	'post_as',
	'comment_as',
	'react_as',
	'send_as',
] as const
