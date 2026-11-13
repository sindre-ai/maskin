import { Resend } from 'resend'

export interface SendInviteEmailParams {
	to: string
	workspaceName: string
	inviterName: string
	role: string
	acceptUrl: string
}

// Thrown when the email provider rejects a send. The provider's message stays on
// the server (logs); callers must not forward it to API clients.
export class InviteEmailSendError extends Error {
	constructor(
		public readonly providerErrorName: string,
		public readonly providerMessage: string,
	) {
		super(`Invite email send failed: ${providerErrorName}`)
		this.name = 'InviteEmailSendError'
	}
}

const DEFAULT_FROM_ADDRESS = 'notifications@maskin.io'
const FROM_NAME = 'Maskin'

/**
 * The From header for every mail: EMAIL_FROM, or the default address. A bare address gets the
 * display name Maskin so inboxes show "Maskin" instead of "notifications"; an address that
 * already has a name ("Name <a@b.c>") is left alone.
 */
export function resolveFrom(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.EMAIL_FROM?.trim() || DEFAULT_FROM_ADDRESS
	return configured.includes('<') ? configured : `${FROM_NAME} <${configured}>`
}

function buildSubject(params: SendInviteEmailParams): string {
	return `${params.inviterName} invited you to ${params.workspaceName} on Maskin`
}

function buildPlaintext(params: SendInviteEmailParams): string {
	return [
		'Hi,',
		'',
		`${params.inviterName} has invited you to join the ${params.workspaceName} workspace on`,
		`Maskin as ${params.role}.`,
		'',
		'Accept the invite:',
		params.acceptUrl,
		'',
		"This invite expires in 7 days. If you weren't expecting it, you can",
		'ignore this email — nothing will happen.',
		'',
		'— The Maskin team',
	].join('\n')
}

function buildHtml(params: SendInviteEmailParams): string {
	const safeName = escapeHtml(params.inviterName)
	const safeWorkspace = escapeHtml(params.workspaceName)
	const safeRole = escapeHtml(params.role)
	const safeUrl = escapeHtml(params.acceptUrl)
	return [
		'<!doctype html>',
		'<html>',
		'<body style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif; color: #111; max-width: 560px; margin: 0 auto; padding: 24px;">',
		'<p>Hi,</p>',
		`<p>${safeName} has invited you to join the <strong>${safeWorkspace}</strong> workspace on Maskin as ${safeRole}.</p>`,
		`<p><a href="${safeUrl}" style="display: inline-block; background: #111; color: #fff; padding: 12px 20px; border-radius: 6px; text-decoration: none;">Accept the invite</a></p>`,
		`<p style="color: #666; font-size: 13px;">Or paste this URL into your browser:<br><a href="${safeUrl}">${safeUrl}</a></p>`,
		'<p style="color: #666; font-size: 13px;">This invite expires in 7 days. If you weren\'t expecting it, you can ignore this email — nothing will happen.</p>',
		'<p style="color: #666; font-size: 13px;">— The Maskin team</p>',
		'</body>',
		'</html>',
	].join('\n')
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

// Local-dev + apps/e2e escape hatch: when RESEND_API_KEY is empty the helper
// logs the intended message to stdout instead of dispatching, so the
// accept-invite flow can be exercised end-to-end without a Resend account.
export async function sendInviteEmail(params: SendInviteEmailParams): Promise<void> {
	const apiKey = process.env.RESEND_API_KEY
	const from = resolveFrom()
	const subject = buildSubject(params)
	const text = buildPlaintext(params)
	const html = buildHtml(params)

	if (!apiKey) {
		console.log('[email:dev-mode] sendInviteEmail — RESEND_API_KEY is empty, not dispatching')
		console.log(`  to: ${params.to}`)
		console.log(`  from: ${from}`)
		console.log(`  subject: ${subject}`)
		console.log('  body:')
		for (const line of text.split('\n')) console.log(`    ${line}`)
		return
	}

	const client = new Resend(apiKey)
	// The Resend SDK resolves with { data: null, error } on API failures (bad key,
	// unverified domain, rejected recipient) and only throws on network errors.
	const { error } = await client.emails.send({ from, to: params.to, subject, text, html })
	if (error) throw new InviteEmailSendError(error.name, error.message)
}

export interface SendEmailParams {
	to: string
	subject: string
	text: string
	html: string
	/** Extra headers, e.g. List-Unsubscribe and List-Unsubscribe-Post. */
	headers?: Record<string, string>
}

export class EmailSendError extends Error {
	constructor(
		public readonly providerErrorName: string,
		public readonly providerMessage: string,
	) {
		super(`Email send failed: ${providerErrorName}`)
		this.name = 'EmailSendError'
	}
}

/** True when a Resend key is set, so a caller can skip instead of claiming work it cannot send. */
export function isEmailConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.RESEND_API_KEY)
}

/**
 * Send one message through Resend. Click tracking is a domain setting and is deliberately not
 * touched here. Returns false (and logs) when no key is set, true once Resend accepted it.
 */
export async function sendEmail(params: SendEmailParams): Promise<boolean> {
	const apiKey = process.env.RESEND_API_KEY
	const from = resolveFrom()
	if (!apiKey) {
		console.log('[email:dev-mode] sendEmail — RESEND_API_KEY is empty, not dispatching')
		console.log(`  from: ${from}`)
		console.log(`  subject: ${params.subject}`)
		return false
	}
	const client = new Resend(apiKey)
	const { error } = await client.emails.send({
		from,
		to: params.to,
		subject: params.subject,
		text: params.text,
		html: params.html,
		...(params.headers ? { headers: params.headers } : {}),
	})
	if (error) throw new EmailSendError(error.name, error.message)
	return true
}

export interface SendPasswordResetEmailParams {
	to: string
	resetUrl: string
}

/**
 * The "Forgot password" mail. The link carries the one-time token, so unlike the invite helper
 * this never logs the message when no key is set: sendEmail's dev mode logs only the subject.
 * Returns false when nothing was sent (no key).
 */
export async function sendPasswordResetEmail(
	params: SendPasswordResetEmailParams,
): Promise<boolean> {
	const safeUrl = escapeHtml(params.resetUrl)
	const text = [
		'Hi,',
		'',
		'Someone asked to reset the password for your Maskin account. Choose a new one here:',
		params.resetUrl,
		'',
		"This link works once and expires in 1 hour. If you didn't ask for it, you can",
		'ignore this email — your password stays the same.',
		'',
		'— The Maskin team',
	].join('\n')
	const html = [
		'<!doctype html>',
		'<html>',
		'<body style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif; color: #111; max-width: 560px; margin: 0 auto; padding: 24px;">',
		'<p>Hi,</p>',
		'<p>Someone asked to reset the password for your Maskin account.</p>',
		`<p><a href="${safeUrl}" style="display: inline-block; background: #111; color: #fff; padding: 12px 20px; border-radius: 6px; text-decoration: none;">Choose a new password</a></p>`,
		`<p style="color: #666; font-size: 13px;">Or paste this URL into your browser:<br><a href="${safeUrl}">${safeUrl}</a></p>`,
		'<p style="color: #666; font-size: 13px;">This link works once and expires in 1 hour. If you didn\'t ask for it, you can ignore this email — your password stays the same.</p>',
		'<p style="color: #666; font-size: 13px;">— The Maskin team</p>',
		'</body>',
		'</html>',
	].join('\n')
	return sendEmail({ to: params.to, subject: 'Reset your Maskin password', text, html })
}
