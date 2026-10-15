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
	// The Resend SDK resolves with { data: null, error } on API failures (bad key,
	// unverified domain, rejected recipient) and only throws on network errors.
	const { error } = await client.emails.send({ from, to: params.to, subject, text, html })
	if (error) throw new InviteEmailSendError(error.name, error.message)
}

// Re-exported so apps/dev can build a per-workspace client without declaring
// its own direct dependency on the SDK.
export { Resend }

export type VoiceFollowupLanguage = 'da' | 'en'

export interface SendVoiceFollowupEmailParams {
	// Pre-resolved by the caller (apps/dev) from the workspace's own Resend
	// integration. This package never resolves credentials for this helper.
	resend: Resend
	from: string
	to: string
	prospectName: string
	callSummary: string
	calendarLink?: string
	// Language of the call the prospect asked for the email on. Defaults to
	// Danish: this bet calls Danish +45 numbers with a Danish agent.
	language?: VoiceFollowupLanguage
	// A mailbox someone reads. Named in the opt-out line and set as Reply-To,
	// because the sender address is not monitored.
	optOutAddress: string
	// The voice contact the email is about. compliance_flag is read first and
	// a disclosure_missing flag (stamped when the AI-disclosure opening was not
	// heard on the call) means the prospect never validly consented to contact.
	contact: { metadata?: Record<string, unknown> | null }
}

export type SendVoiceFollowupEmailResult =
	| { sent: true }
	| { sent: false; reason: 'disclosure_missing' }

// Thrown when the email provider rejects a follow-up send. Same contract as
// InviteEmailSendError: the provider's message stays on the server.
export class VoiceFollowupEmailSendError extends Error {
	constructor(
		public readonly providerErrorName: string,
		public readonly providerMessage: string,
	) {
		super(`Voice follow-up email send failed: ${providerErrorName}`)
		this.name = 'VoiceFollowupEmailSendError'
	}
}

function safeCalendarLink(link: string | undefined): string | undefined {
	return link && /^https:\/\//i.test(link) ? link : undefined
}

interface FollowupCopy {
	subject: string
	greeting: (name: string) => string
	intro: string
	linkLead: string
	optOut: (address: string) => string
	signature: string
}

// The Danish copy mirrors the English text, opt-out wording included. It needs
// a native read before go-live.
const FOLLOWUP_COPY: Record<VoiceFollowupLanguage, FollowupCopy> = {
	en: {
		subject: 'Following up on our call',
		greeting: (name) => `Hi ${name},`,
		intro:
			'Thanks for taking the call. As you asked, here is a short recap of what we talked about:',
		linkLead: 'You can join the meeting here:',
		optOut: (address) =>
			`This is the only email we will send you about this call. If you do not want further email from Maskin, reply to this message or write to ${address} and we will stop.`,
		signature: '— Maskin',
	},
	da: {
		subject: 'Opfølgning på vores samtale',
		greeting: (name) => `Hej ${name},`,
		intro: 'Tak for samtalen. Som du bad om, kommer her et kort resumé af, hvad vi talte om:',
		linkLead: 'Du kan deltage i mødet her:',
		optOut: (address) =>
			`Dette er den eneste e-mail, vi sender dig om samtalen. Hvis du ikke ønsker flere e-mails fra Maskin, så svar på denne mail eller skriv til ${address}, så stopper vi.`,
		signature: '— Maskin',
	},
}

function followupCopy(params: SendVoiceFollowupEmailParams): FollowupCopy {
	return FOLLOWUP_COPY[params.language ?? 'da']
}

function buildFollowupPlaintext(params: SendVoiceFollowupEmailParams): string {
	const copy = followupCopy(params)
	const link = safeCalendarLink(params.calendarLink)
	return [
		copy.greeting(params.prospectName),
		'',
		copy.intro,
		'',
		params.callSummary,
		...(link ? ['', copy.linkLead, link] : []),
		'',
		copy.optOut(params.optOutAddress),
		'',
		copy.signature,
	].join('\n')
}

function buildFollowupHtml(params: SendVoiceFollowupEmailParams): string {
	const copy = followupCopy(params)
	const link = safeCalendarLink(params.calendarLink)
	const safeLink = link ? escapeHtml(link) : undefined
	return [
		'<!doctype html>',
		'<html>',
		'<body style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif; color: #111; max-width: 560px; margin: 0 auto; padding: 24px;">',
		`<p>${escapeHtml(copy.greeting(params.prospectName))}</p>`,
		`<p>${escapeHtml(copy.intro)}</p>`,
		`<p style="white-space: pre-line;">${escapeHtml(params.callSummary)}</p>`,
		...(safeLink
			? [`<p>${escapeHtml(copy.linkLead)}<br><a href="${safeLink}">${safeLink}</a></p>`]
			: []),
		`<p style="color: #666; font-size: 13px;">${escapeHtml(copy.optOut(params.optOutAddress))}</p>`,
		`<p style="color: #666; font-size: 13px;">${escapeHtml(copy.signature)}</p>`,
		'</body>',
		'</html>',
	].join('\n')
}

// Post-call recap, sent only when the prospect asked for it on the call
// (Markedsføringsloven §10(1) prior consent; the caller decides that). Transport
// only: the caller hands in a ready Resend client and sender.
export async function sendVoiceFollowupEmail(
	params: SendVoiceFollowupEmailParams,
): Promise<SendVoiceFollowupEmailResult> {
	if (params.contact.metadata?.compliance_flag === 'disclosure_missing') {
		return { sent: false, reason: 'disclosure_missing' }
	}

	const { error } = await params.resend.emails.send({
		from: params.from,
		to: params.to,
		replyTo: params.optOutAddress,
		subject: followupCopy(params).subject,
		text: buildFollowupPlaintext(params),
		html: buildFollowupHtml(params),
	})
	if (error) throw new VoiceFollowupEmailSendError(error.name, error.message)
	return { sent: true }
}
