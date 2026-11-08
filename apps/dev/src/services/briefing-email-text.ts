/**
 * briefing-email-text.ts — the summary email, as pure functions.
 *
 * The facts (what waits, what finished) and their wording come from the daily briefing push
 * (`buildBriefingText`), so an email never says a different number than the push or the For You
 * screen. No AI call, no message bodies: only the card headline the push already shows.
 *
 * Steps 1 to 3 (day 1, 3 and 7 after sign-up) carry one line of how-to and no offers. After that
 * the weekly summary has none.
 */
import type { BriefingText } from './briefing-push-scheduler'

export type EmailStep = 1 | 2 | 3 | 'weekly'

/** The how-to line per onboarding step. Plain help; nothing here may promise an unbuilt feature. */
export const STEP_INTRO: Record<1 | 2 | 3, string> = {
	1: 'Your agents work in the background. When one needs you, it shows up on your For You screen.',
	2: 'A card is one thing waiting on you. Pick an option and the agent carries on.',
	3: 'A loop is a routine your agents repeat on their own. You only see what needs you.',
}

export interface SummaryEmailInput {
	summary: BriefingText
	step: EmailStep
	/** Where the button goes: the top waiting card, or the workspace home. Already tagged. */
	buttonUrl: string
	/** Signed stop link; the one-click header points at the same URL. */
	stopUrl: string
}

export interface SummaryEmail {
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

export function buttonLabel(summary: BriefingText): string {
	return summary.waiting > 0 ? 'Open it' : 'Open Maskin'
}

export function buildSummaryEmail(input: SummaryEmailInput): SummaryEmail {
	const { summary, step, buttonUrl, stopUrl } = input
	const intro = step === 'weekly' ? null : STEP_INTRO[step]
	const label = buttonLabel(summary)

	const text = [
		summary.title,
		...(summary.body ? ['', summary.body] : []),
		...(intro ? ['', intro] : []),
		'',
		`${label}: ${buttonUrl}`,
		'',
		`Stop these emails: ${stopUrl}`,
	].join('\n')

	const html = [
		'<!doctype html>',
		'<html>',
		'<body style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif; color: #111; max-width: 560px; margin: 0 auto; padding: 24px;">',
		`<p style="font-size: 18px; font-weight: 600; margin: 0 0 8px;">${escapeHtml(summary.title)}</p>`,
		...(summary.body ? [`<p style="margin: 0 0 16px;">${escapeHtml(summary.body)}</p>`] : []),
		...(intro ? [`<p style="color: #444; margin: 0 0 16px;">${escapeHtml(intro)}</p>`] : []),
		`<p><a href="${escapeHtml(buttonUrl)}" style="display: inline-block; background: #111; color: #fff; padding: 12px 20px; border-radius: 6px; text-decoration: none;">${escapeHtml(label)}</a></p>`,
		`<p style="color: #666; font-size: 13px;"><a href="${escapeHtml(stopUrl)}" style="color: #666;">Stop these emails</a></p>`,
		'</body>',
		'</html>',
	].join('\n')

	return {
		subject: summary.title,
		text,
		html,
		headers: {
			'List-Unsubscribe': `<${stopUrl}>`,
			'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
		},
	}
}
