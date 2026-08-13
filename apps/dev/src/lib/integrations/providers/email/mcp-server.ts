import type { Database } from '@maskin/db'
import { actors, workspaceMembers } from '@maskin/db/schema'
import { EmailSendError, readResendEnv, sendEmail, stripExternalImages } from '@maskin/email'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { and, eq, sql } from 'drizzle-orm'
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
	/** DB handle bound to the request. Used for the workspace-member allowlist. */
	db: Database
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
 *   Enforced server-side by the allowlist join in this handler, not by prompt.
 * - `rate_limited` — per-agent 10-per-hour ceiling tripped (T7).
 * - `email_not_configured` — RESEND_API_KEY / EMAIL_FROM missing on the
 *   host. The MCP entry is auto-injected only when both env vars are set,
 *   so agents shouldn't normally see this — it exists so a config drift
 *   fails loudly instead of silently.
 * - `send_failed` — Resend/transport error. The provider's message is
 *   forwarded so an operator can grep it out of the logs.
 */
export type SendEmailErrorCode =
	| 'recipient_not_in_workspace'
	| 'rate_limited'
	| 'email_not_configured'
	| 'send_failed'

interface SuccessPayload {
	ok: true
	messageId: string
}

interface ErrorPayload {
	ok: false
	error: SendEmailErrorCode
	message: string
}

const TOOL_DESCRIPTION = [
	'Send a transactional email from Maskin to a workspace member.',
	'',
	"Sends are gated to the calling agent's workspace: `to` must resolve to a workspace member; every other recipient is rejected server-side with `recipient_not_in_workspace`. External `<img>` and CSS `url(...)` references in the body are stripped before send.",
	'',
	'Per-agent rate limit: 10 sends per rolling hour. Requests over the limit come back with `{ ok: false, error: "rate_limited" }` (no send is attempted).',
	'',
	'Every response is a JSON envelope on the `content` channel:',
	'- Success: `{ "ok": true, "messageId": "<resend-id>" }`',
	'- Error: `{ "ok": false, "error": "<code>", "message": "<human-readable>" }` where `<code>` is one of `recipient_not_in_workspace`, `rate_limited`, `email_not_configured`, or `send_failed`.',
].join('\n')

function toTextEnvelope(payload: SuccessPayload | ErrorPayload) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

function escapeHtml(input: string): string {
	return input
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

// Minimal HTML derivation when the agent supplies only bodyText. Preserves
// whitespace so line breaks in the plain-text body survive rendering, without
// pulling a full React Email template into a free-form agent surface.
function deriveHtmlFromText(text: string): string {
	return `<pre style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; white-space: pre-wrap; margin: 0;">${escapeHtml(
		text,
	)}</pre>`
}

async function isWorkspaceRecipient(
	db: Database,
	workspaceId: string,
	recipientEmail: string,
): Promise<boolean> {
	const [row] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				sql`lower(${actors.email}) = lower(${recipientEmail})`,
			),
		)
		.limit(1)
	return !!row
}

/**
 * Build a fresh MCP server per request. Exposes one tool — `send_email` —
 * that enforces the workspace-member allowlist server-side before any Resend
 * call, strips external image references from the body (T8), and dispatches
 * through the shared @maskin/email `sendEmail` helper so the ship metric
 * (`email_sent` PostHog event) fires uniformly with Layer 1 sends.
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
			const logContext = {
				workspaceId: ctx.workspaceId,
				actorId: ctx.actorId,
				agentLabel: ctx.agentLabel,
				to: args.to,
				subjectLength: args.subject.length,
				bodyTextLength: args.bodyText.length,
				hasBodyHtml: typeof args.bodyHtml === 'string',
			}
			logger.info('send_email tool invoked', logContext)

			const allowed = await isWorkspaceRecipient(ctx.db, ctx.workspaceId, args.to)
			if (!allowed) {
				logger.warn('send_email rejected: recipient not in workspace', logContext)
				return toTextEnvelope({
					ok: false,
					error: 'recipient_not_in_workspace',
					message:
						'Recipient is not a member of the calling workspace. send_email only delivers to workspace members.',
				})
			}

			try {
				readResendEnv()
			} catch (err) {
				logger.error('send_email rejected: email provider not configured', {
					...logContext,
					message: err instanceof Error ? err.message : String(err),
				})
				return toTextEnvelope({
					ok: false,
					error: 'email_not_configured',
					message:
						'Email provider is not configured on this host. Set RESEND_API_KEY and EMAIL_FROM.',
				})
			}

			const strippedText = stripExternalImages(args.bodyText)
			const strippedHtml =
				typeof args.bodyHtml === 'string'
					? stripExternalImages(args.bodyHtml)
					: { bodyText: deriveHtmlFromText(strippedText.bodyText), removed: 0 }

			try {
				const { id } = await sendEmail({
					to: args.to,
					subject: args.subject,
					text: strippedText.bodyText,
					html: strippedHtml.bodyText,
					analytics: {
						workspaceId: ctx.workspaceId,
						emailType: 'agent',
						agentId: ctx.actorId,
					},
				})
				logger.info('send_email delivered', {
					...logContext,
					messageId: id,
					externalImagesRemoved: strippedText.removed + strippedHtml.removed,
				})
				return toTextEnvelope({ ok: true, messageId: id })
			} catch (err) {
				const providerCode = err instanceof EmailSendError ? err.providerCode : 'unexpected_error'
				const message = err instanceof Error ? err.message : String(err)
				logger.error('send_email dispatch failed', {
					...logContext,
					providerCode,
					message,
				})
				return toTextEnvelope({
					ok: false,
					error: 'send_failed',
					message: `${providerCode}: ${message}`,
				})
			}
		},
	)

	return server
}
