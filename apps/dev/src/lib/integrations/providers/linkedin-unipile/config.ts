import type { ProviderConfig } from '../../types'

/**
 * linkedin-unipile provider config.
 *
 * Registered in the integration registry so it shows up in
 * GET /api/integrations/providers (which the Settings > Integrations page
 * reads via `list_integration_providers`). The actual connect + callback
 * routes live in `apps/dev/src/routes/integrations-linkedin-unipile.ts`
 * because the LinkedIn Hosted Auth Wizard is NOT OAuth2 — see spec §2.
 *
 * `auth.type = 'oauth2_custom'` is a sentinel here: it keeps the provider
 * out of the generic OAuth2 handler's path (which would try to build an
 * authorization URL) while still satisfying ProviderConfig's discriminated
 * union. The generic /{provider}/connect handler explicitly early-returns
 * for this provider name and directs the caller to the dedicated route.
 */
export const config: ProviderConfig = {
	name: 'linkedin-unipile',
	displayName: 'LinkedIn',
	description:
		'Send LinkedIn DMs and read conversations on behalf of the connected member via LinkedIn.',

	auth: {
		type: 'oauth2_custom',
	},

	// Served in-process at /api/integrations/linkedin-unipile/mcp/:instanceSlug —
	// one MCP endpoint per connected LinkedIn identity (personal profile plus
	// each admined page). `autoInject` is false on purpose (Magnus 2026-09-14
	// reversal of the workspace-wide auto-inject that shipped in PR #1595 / bet
	// 56c2ffd7): a workspace with many agents does not want every agent silently
	// attached to every LinkedIn identity — the operator picks per-agent, per-
	// identity. envKey is retained for symmetry with other providers; the MCP
	// route authenticates on the Maskin API key in the Authorization header,
	// not on a per-provider container env var.
	//
	// Deliberately no `server`, matching github. linkedin-unipile is multi-
	// identity: the frontend Quick Add UI enumerates identities from
	// /api/integrations/linkedin-unipile/identities and writes one mcpServers
	// entry per identity, each targeting the per-slug URL. There is no single
	// paste-ready `.../mcp` shape to hand out — the aggregate URL is a
	// deprecated, empty-tool endpoint (see routes/integrations-linkedin-unipile-mcp.ts)
	// and advertising it as the canonical discovery answer would silently trap
	// any non-browser client that pastes the discovery spec verbatim. Discovery
	// clients see `mcp: { envKey, autoInject: false }` with no `server` — the
	// same "no single spec" signal github uses for its per-installation surface.
	// The route test enumerating which providers omit `server` in
	// `integrations.test.ts` is what holds this line.
	//
	// `entry` is how agents' copies of those per-identity URLs are recognised
	// (mcp-detach.ts): one credential owns the slugs that start with
	// `linkedin-{unipileAccSlug}-`. A credential that never enumerated an
	// identity owns none.
	mcp: {
		envKey: 'LINKEDIN_UNIPILE_TOKEN',
		autoInject: false,
		entry: {
			kind: 'per-identity',
			urlPath: '/api/integrations/linkedin-unipile/mcp',
			slugPrefix: (owner) => (owner.unipileAccSlug ? `linkedin-${owner.unipileAccSlug}-` : null),
		},
	},

	// Event definitions only. No `mapping` key and no `webhook` key: a webhook
	// key would opt the provider into the generic /api/webhooks/:provider route,
	// and Unipile deliveries are handled by the dedicated route in
	// routes/integrations-linkedin-unipile.ts using event-map.ts.
	events: {
		definitions: [
			{
				entityType: 'linkedin.message',
				actions: ['received', 'received_cold', 'received_unresolved'],
				label: 'LinkedIn message',
			},
			{
				entityType: 'linkedin.connection',
				actions: ['accepted', 'new'],
				label: 'LinkedIn connection',
			},
			{
				entityType: 'linkedin.account',
				actions: ['status_changed'],
				label: 'LinkedIn account status',
			},
		],
	},

	// What agents can draft here for a person to read, edit and approve. The send tools are
	// served per identity, so each is prefixed `linkedin-{account}-{identity}__`; `sendTool`
	// names the verb. Limits mirror operations.ts (8000-character messages, 3000-character
	// posts, the 300-character invite note).
	deliverables: [
		{
			kind: 'linkedin_message',
			label: 'LinkedIn message',
			// `reply` or `send_message` with the object's id sends the approved text; see send-object.ts.
			sendTool: 'reply',
			// Mirrors the limit in operations.ts.
			bodyMaxLength: 8000,
			// The sales loop files its replies as tasks with `channel: linkedin_dm`; they are
			// drafts of a message without anyone having to add a kind.
			alsoMatches: [{ key: 'channel', value: 'linkedin_dm' }],
			fields: [
				// A reply goes into a conversation the agent already holds, so a recipient is not
				// required to send; it is recommended, so the card can say who it goes to. A
				// name or profile link, not checked as an address.
				{ key: 'to', label: 'To', type: 'recipients', role: 'to', recommended: true },
				// The conversation a reply goes into. Not shown; `reply` reads it when it is
				// given an object id instead of the text.
				{ key: 'thread_id', label: 'Conversation', type: 'text', slot: 'hidden' },
				// The message being answered, shown above the draft so it is read in context.
				{ key: 'reply_to', label: 'In reply to', type: 'text', slot: 'context' },
				// A first message has no conversation yet: the person it goes to, by LinkedIn id.
				// Shown, not hidden, so it is part of what an approval is bound to.
				{ key: 'recipient_provider_id', label: 'LinkedIn id', type: 'text' },
				// The one workspace file (PDF, PNG or JPEG) sent with the message. Shown for the
				// same reason: swapping the file withdraws the approval.
				{ key: 'attachment_file_id', label: 'Attachment', type: 'text' },
			],
		},
		{
			kind: 'linkedin_connection_request',
			label: 'LinkedIn connection request',
			sendTool: 'send_connection_request',
			bodyMaxLength: 300,
			fields: [{ key: 'to', label: 'To', type: 'recipients', required: true, role: 'to' }],
		},
		{
			kind: 'linkedin_inmail',
			label: 'LinkedIn InMail',
			sendTool: 'send_inmail',
			// Classic InMail takes no subject (Unipile only takes one for Sales Navigator and
			// Recruiter), and the limit is the one LinkedIn gives a classic InMail.
			bodyMaxLength: 1900,
			fields: [
				{ key: 'to', label: 'To', type: 'recipients', required: true, role: 'to' },
				// The id the send goes to. A detail line, not hidden, so it is part of what a person
				// approves: hidden fields are not hashed, and an edited recipient must withdraw the approval.
				{ key: 'recipient_provider_id', label: 'LinkedIn id', type: 'text', required: true },
				// One approved workspace file; a detail line too, so it is hashed into the approval.
				{ key: 'attachment_file_id', label: 'Attachment', type: 'text' },
			],
		},
		{
			kind: 'linkedin_post',
			label: 'LinkedIn post',
			sendTool: 'publish_post',
			bodyMaxLength: 3000,
			// The Copywriter's posts are `content` objects with `content_type: linkedin_post`
			// and a header (account, voice, angle) above the copy, so they preview as posts
			// without anyone adding a kind, showing only what would be published.
			alsoMatches: [{ key: 'content_type', value: 'linkedin_post' }],
			bodyBlock: { start: '--- POST ---', end: '--- MEDIA ---' },
			fields: [
				{ key: 'account', label: 'Posting as', type: 'text' },
				{ key: 'scheduled_date', label: 'Scheduled', type: 'text' },
			],
		},
	],

	externalIdDisplay: 'installation',
}
