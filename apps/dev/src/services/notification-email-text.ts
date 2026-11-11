/**
 * notification-email-text.ts — the email for one notification (or a rolled-up few), as pure
 * functions. It carries the notification's own title and text, one button to the exact card or
 * chat, and the stop link for that kind. No AI call, no extra copy.
 */
import { clip } from './briefing-push-scheduler'

/** Most characters of the notification's own text shown in the mail. */
const MAX_BODY_CHARS = 400

export interface NotificationEmailInput {
	title: string
	/** The notification's own text; null when it has none. */
	body: string | null
	/** Set when several cards are folded into one mail ("3 things need you"). */
	rollupCount?: number
	/** Already tagged with the email surface. */
	buttonUrl: string
	buttonLabel: string
	/** Signed stop link that switches off this kind of email only. */
	stopUrl: string
}

export interface NotificationEmail {
	subject: string
	text: string
	html: string
	headers: Record<string, string>
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

export function buildNotificationEmail(input: NotificationEmailInput): NotificationEmail {
	const { rollupCount, buttonUrl, buttonLabel, stopUrl } = input
	const subject = rollupCount ? `${rollupCount} things need you` : clip(input.title, 120)
	const body = rollupCount ? null : input.body ? clip(input.body, MAX_BODY_CHARS) : null

	const text = [
		subject,
		...(body ? ['', body] : []),
		'',
		`${buttonLabel}: ${buttonUrl}`,
		'',
		`Stop these emails: ${stopUrl}`,
	].join('\n')

	const html = [
		'<!doctype html>',
		'<html>',
		'<body style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif; color: #111; max-width: 560px; margin: 0 auto; padding: 24px;">',
		`<p style="font-size: 18px; font-weight: 600; margin: 0 0 8px;">${escapeHtml(subject)}</p>`,
		...(body ? [`<p style="margin: 0 0 16px;">${escapeHtml(body)}</p>`] : []),
		`<p><a href="${escapeHtml(buttonUrl)}" style="display: inline-block; background: #111; color: #fff; padding: 12px 20px; border-radius: 6px; text-decoration: none;">${escapeHtml(buttonLabel)}</a></p>`,
		`<p style="color: #666; font-size: 13px;"><a href="${escapeHtml(stopUrl)}" style="color: #666;">Stop these emails</a></p>`,
		'</body>',
		'</html>',
	].join('\n')

	return {
		subject,
		text,
		html,
		headers: {
			'List-Unsubscribe': `<${stopUrl}>`,
			'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
		},
	}
}
