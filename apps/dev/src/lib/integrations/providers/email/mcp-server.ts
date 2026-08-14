import type { Database } from '@maskin/db'
import { actors, workspaceMembers } from '@maskin/db/schema'
import { readResendEnv, sanitizeSendError, sendEmail, stripExternalImages } from '@maskin/email'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { logger } from '../../../logger'
import {
	checkAgentEmailRateLimit,
	findExistingAgentEmailSend,
	isUniqueViolation,
	readAgentEmailRateLimitPerHour,
	recordAgentEmailSend,
} from './hardening'

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
const IDEMPOTENCY_KEY_MAX = 200

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
	idempotencyKey: z
		.string()
		.min(1)
		.max(IDEMPOTENCY_KEY_MAX)
		.optional()
		.describe(
			'Optional retry-safety key. A second call with the same key from the same agent in the same workspace is short-circuited to `{ ok: false, error: "already_sent" }` without a provider dispatch — safe to reuse on retry.',
		),
}

/**
 * `send_email` result contract — kept as a JSON envelope so both success
 * and expected errors ride the standard MCP `content` channel and are
 * visible to the calling agent without inventing tool-level exceptions.
 *
 * Error codes:
 * - `recipient_not_in_workspace` — `to` is not a member of the workspace.
 * - `rate_limit_exceeded` — per-agent rolling-hour ceiling tripped. Also
 *   fires when the ledger table can't be read (fail-closed on rate-check
 *   error, per the T7 brief). `retryAfterSeconds` is a best-effort hint
 *   for when the caller may try again.
 * - `already_sent` — a prior send from this (workspace, agent) already
 *   used the supplied `idempotencyKey`. The original send stands; no new
 *   provider dispatch was made.
 * - `email_not_configured` — RESEND_API_KEY / EMAIL_FROM missing.
 * - `send_failed` — Resend or transport error. The response carries a
 *   generic message and a sanitized code — the raw provider text and
 *   message id stay in the server log via the caller's logger.
 */
export type SendEmailErrorCode =
	| 'recipient_not_in_workspace'
	| 'rate_limit_exceeded'
	| 'already_sent'
	| 'email_not_configured'
	| 'send_failed'

interface SuccessPayload {
	ok: true
	messageId: string
}

interface RateLimitPayload {
	ok: false
	error: 'rate_limit_exceeded'
	message: string
	retryAfterSeconds: number
}

interface AlreadySentPayload {
	ok: false
	error: 'already_sent'
	message: string
	idempotencyKey: string
}

interface GenericErrorPayload {
	ok: false
	error: Exclude<SendEmailErrorCode, 'rate_limit_exceeded' | 'already_sent'>
	message: string
}

type ToolPayload = SuccessPayload | RateLimitPayload | AlreadySentPayload | GenericErrorPayload

const TOOL_DESCRIPTION = [
	'Send a transactional email from Maskin to a workspace member.',
	'',
	"Sends are gated to the calling agent's workspace: `to` must resolve to a workspace member; every other recipient is rejected server-side with `recipient_not_in_workspace`. External `<img>` and CSS `url(...)` references in the body are stripped before send.",
	'',
	'Per-agent rate limit: 10 sends per rolling hour (configurable via `AGENT_EMAIL_RATE_LIMIT_PER_HOUR`). The rate check fires before the recipient allowlist so probing invalid recipients still counts. Requests over the ceiling come back with `{ ok: false, error: "rate_limit_exceeded", retryAfterSeconds }`; no send is attempted.',
	'',
	'Idempotency: pass an optional `idempotencyKey` to make a retry safe. A second call from the same agent in the same workspace with the same key returns `{ ok: false, error: "already_sent", idempotencyKey }` without dispatching. Keys are scoped per (workspace, agent) — the same string in a different workspace is a distinct send.',
	'',
	'Every response is a JSON envelope on the `content` channel:',
	'- Success: `{ "ok": true, "messageId": "<resend-id>" }`',
	'- Error: `{ "ok": false, "error": "<code>", "message": "<generic>" }` where `<code>` is one of `recipient_not_in_workspace`, `rate_limit_exceeded`, `already_sent`, `email_not_configured`, or `send_failed`. The `message` field is a fixed generic string; the raw provider error text is never included in the response.',
].join('\n')

function toTextEnvelope(payload: ToolPayload) {
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
 * that runs the T7 hardening chain in this order (per the brief):
 *
 *   rate-limit → idempotency lookup → workspace-member allowlist →
 *   env-configured → strip external images → Resend dispatch → record
 *
 * Rate-limit first is deliberate: putting it after the allowlist would let
 * a caller burn no budget while probing unknown recipients. Idempotency
 * runs before allowlist so a retry of an original recipient-invalid send
 * returns `already_sent` deterministically (rather than re-doing the
 * allowlist lookup and diverging when membership drifts mid-flight).
 * All error responses are sanitized: no provider text, message ids, or
 * recipient data ever ride out on the tool response.
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
				hasIdempotencyKey: typeof args.idempotencyKey === 'string',
			}
			logger.info('send_email tool invoked', logContext)

			const rateLimitCheck = await checkAgentEmailRateLimit(ctx.db, ctx.actorId, {
				limitPerHour: readAgentEmailRateLimitPerHour(),
			})
			if (!rateLimitCheck.ok) {
				logger.warn('send_email rejected: rate limit exceeded', {
					...logContext,
					limit: rateLimitCheck.limit,
					used: rateLimitCheck.used,
					retryAfterSeconds: rateLimitCheck.retryAfterSeconds,
				})
				return toTextEnvelope({
					ok: false,
					error: 'rate_limit_exceeded',
					message: `Per-agent email rate limit of ${rateLimitCheck.limit} per hour reached. Retry in ${rateLimitCheck.retryAfterSeconds}s.`,
					retryAfterSeconds: rateLimitCheck.retryAfterSeconds,
				})
			}

			if (typeof args.idempotencyKey === 'string') {
				const existing = await findExistingAgentEmailSend(
					ctx.db,
					ctx.workspaceId,
					ctx.actorId,
					args.idempotencyKey,
				)
				if (existing) {
					logger.info('send_email short-circuited: duplicate idempotency key', {
						...logContext,
					})
					return toTextEnvelope({
						ok: false,
						error: 'already_sent',
						message:
							'A prior send from this agent in this workspace already used this idempotency key. No new email was dispatched.',
						idempotencyKey: args.idempotencyKey,
					})
				}
			}

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

			let providerMessageId: string
			try {
				const result = await sendEmail({
					to: args.to,
					subject: args.subject,
					text: strippedText.bodyText,
					html: strippedHtml.bodyText,
					idempotencyKey: args.idempotencyKey,
					analytics: {
						workspaceId: ctx.workspaceId,
						emailType: 'agent',
						agentId: ctx.actorId,
					},
				})
				providerMessageId = result.id
			} catch (err) {
				const sanitized = sanitizeSendError(err)
				logger.error('send_email dispatch failed', {
					...logContext,
					sanitizedCode: sanitized.code,
					// The raw provider text + cause stay here in the server log,
					// where operators can grep them out. They never enter the
					// tool response — that's the whole point of sanitization.
					rawMessage: err instanceof Error ? err.message : String(err),
				})
				return toTextEnvelope({
					ok: false,
					error: 'send_failed',
					message: sanitized.message,
				})
			}

			try {
				await recordAgentEmailSend(ctx.db, {
					workspaceId: ctx.workspaceId,
					actorId: ctx.actorId,
					idempotencyKey: args.idempotencyKey ?? null,
					providerMessageId,
				})
			} catch (err) {
				// A concurrent send with the same idempotency key beat us to
				// the row — the send just happened twice on the wire (Resend
				// itself dedupes via the SDK's `Idempotency-Key` header, so
				// this is best-effort at worst). Surface `already_sent` to
				// keep the contract stable rather than a bare 500.
				if (isUniqueViolation(err) && typeof args.idempotencyKey === 'string') {
					logger.warn('send_email raced on idempotency key', {
						...logContext,
						providerMessageId,
					})
					return toTextEnvelope({
						ok: false,
						error: 'already_sent',
						message:
							'A concurrent send from this agent in this workspace used the same idempotency key. No additional email was recorded.',
						idempotencyKey: args.idempotencyKey,
					})
				}
				// Any other ledger write failure is unexpected; log and surface
				// success anyway (the email did go out). Rate-limit counting
				// will be slightly under-counted for this send, which is
				// preferable to lying to the caller about delivery.
				logger.error('send_email ledger write failed after successful send', {
					...logContext,
					providerMessageId,
					message: err instanceof Error ? err.message : String(err),
				})
			}

			logger.info('send_email delivered', {
				...logContext,
				messageId: providerMessageId,
				externalImagesRemoved: strippedText.removed + strippedHtml.removed,
			})
			return toTextEnvelope({ ok: true, messageId: providerMessageId })
		},
	)

	return server
}
