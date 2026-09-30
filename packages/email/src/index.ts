import { Resend } from 'resend'

export interface SendInviteEmailParams {
	to: string
	workspaceName: string
	inviterName: string
	role: string
	acceptUrl: string
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
	const from = process.env.EMAIL_FROM ?? 'notifications@maskin.io'
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
	await client.emails.send({ from, to: params.to, subject, text, html })
}
