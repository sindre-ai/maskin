import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { logger } from '../../../logger'

/**
 * Context an agent's email tool binds against. Populated per-request by the
 * HTTP MCP route from the calling agent + workspace so the handler never
 * spreads workspace-scoped state across sessions.
 */
export interface EmailToolContext {
	workspaceId: string
	actorId: string
	/** Human-readable "agent · in workspace" subscript for logs. */
	agentLabel: string
}

const RECIPIENT_MAX = 254 // RFC 5321
const SUBJECT_MAX = 200
const BODY_MAX = 100_000

const sendEmailInput = {
	to: z
		.string()
		.min(3)
		.max(RECIPIENT_MAX)
		.email()
		.describe(
			"Recipient email. Must be a member of the calling agent's workspace — the server rejects with `recipient_not_in_workspace` otherwise.",
		),
	subject: z.string().min(1).max(SUBJECT_MAX).describe('Message subject. 1–200 characters.'),
	bodyText: z
		.string()
		.min(1)
		.max(BODY_MAX)
		.describe(
			'Plain-text body. Rendered as the text/plain part; also used to derive the HTML body when `bodyHtml` is omitted.',
		),
	bodyHtml: z
		.string()
		.max(BODY_MAX)
		.optional()
		.describe(
			'Optional HTML body. External `<img>` sources and CSS `url(...)` references are stripped server-side before send (exfil protection).',
		),
}

/**
 * Send `send_email` result contract — kept as a JSON envelope so both success
 * and expected errors ride the standard MCP `content` channel and are visible
 * to the calling agent without inventing tool-level exceptions.
 *
 * Error codes:
 * - `recipient_not_in_workspace` — `to` is not a member of the workspace.
 *   Enforced server-side by the T6 allowlist, not by prompt.
 * - `rate_limited` — per-agent 10-per-hour ceiling tripped (T7).
 * - `email_not_configured` — RESEND_API_KEY / EMAIL_FROM missing on the
 *   host. The MCP entry is auto-injected only when both env vars are set,
 *   so agents shouldn't normally see this — it exists so a config drift
 *   fails loudly instead of silently.
 * - `send_failed` — Resend/transport error. The provider's message is
 *   forwarded so an operator can grep it out of the logs.
 * - `not_available_yet` — the send path (T6 workspace allowlist + Resend
 *   dispatch) has not landed in this build. The tool is discoverable and
 *   its schema is stable so agent-side code can be written against it;
 *   real sends unlock when T6 replaces this stub handler.
 */
export type SendEmailErrorCode =
	| 'recipient_not_in_workspace'
	| 'rate_limited'
	| 'email_not_configured'
	| 'send_failed'
	| 'not_available_yet'

const TOOL_DESCRIPTION = [
	'Send a transactional email from Maskin to a workspace member.',
	'',
	"Sends are gated to the calling agent's workspace: `to` must resolve to a workspace member; every other recipient is rejected server-side with `recipient_not_in_workspace`. External `<img>` and CSS `url(...)` references in the body are stripped before send.",
	'',
	'Per-agent rate limit: 10 sends per rolling hour. Requests over the limit come back with `{ ok: false, error: "rate_limited" }` (no send is attempted).',
	'',
	'Every response is a JSON envelope on the `content` channel:',
	'- Success: `{ "ok": true, "messageId": "<resend-id>" }`',
	'- Error: `{ "ok": false, "error": "<code>", "message": "<human-readable>" }` where `<code>` is one of `recipient_not_in_workspace`, `rate_limited`, `email_not_configured`, `send_failed`, or (until T6 lands) `not_available_yet`.',
].join('\n')

/**
 * Build a fresh MCP server per request. Exposes one tool — `send_email` —
 * whose schema, description, and error contract are stable now so agent
 * authors can write code against them; the send path itself is filled in
 * by T6 (workspace allowlist + Resend dispatch) and T7 (rate limiter). This
 * server intentionally does NOT reach for RESEND_API_KEY or hit the Resend
 * SDK — those concerns land with T6.
 */
export function createEmailMcpServer(ctx: EmailToolContext): McpServer {
	const server = new McpServer({ name: 'maskin-email', version: '0.1.0' })

	server.registerTool(
		'send_email',
		{
			description: TOOL_DESCRIPTION,
			inputSchema: sendEmailInput,
		},
		async (args) => {
			logger.info('send_email tool invoked', {
				workspaceId: ctx.workspaceId,
				actorId: ctx.actorId,
				agentLabel: ctx.agentLabel,
				to: args.to,
				subjectLength: args.subject.length,
				bodyTextLength: args.bodyText.length,
				hasBodyHtml: typeof args.bodyHtml === 'string',
			})

			const payload: {
				ok: false
				error: SendEmailErrorCode
				message: string
			} = {
				ok: false,
				error: 'not_available_yet',
				message:
					'send_email is registered but the workspace allowlist and Resend dispatch handler have not landed yet. The tool schema and error contract are stable — safe to build against.',
			}

			return {
				content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
			}
		},
	)

	return server
}
