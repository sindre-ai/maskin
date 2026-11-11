/**
 * notification-email-text.ts — the email for one notification (or a rolled-up few), as pure
 * functions. It carries the notification's own title and text, one button to the exact card or
 * chat, and the stop link for that kind. No AI call, no extra copy.
 */
import {
	bigNumber,
	button,
	clipAtWord as clip,
	headline,
	paragraph,
	renderEmail,
} from './email-layout'

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

	const html = renderEmail({
		// The hidden preview adds the notification's own text; with none, the button's own label.
		preheader: body ?? buttonLabel,
		blocks: [
			rollupCount ? bigNumber(rollupCount, 'things need you') : headline(subject),
			...(body ? [paragraph(body)] : []),
			button(buttonUrl, buttonLabel),
		],
		stopUrl,
	})

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
