/**
 * flow-activity-text.ts — the Flow activity email, as pure functions.
 *
 * One mail names the flow and lists the runs that finished since the last mail for that flow, with
 * one button to the flow. Run lines read the way the summary email reads them. It says only that
 * runs finished: no result, no success claim, no AI call.
 */
import { clip } from './briefing-push-scheduler'

/** Most run lines in one mail; the rest become "and N more". */
export const MAX_FLOW_ACTIVITY_RUNS = 5

export interface FlowActivityRun {
	agentName: string
	objectTitle: string | null
}

export interface FlowActivityEmailInput {
	flowName: string
	/** Newest first. */
	runs: FlowActivityRun[]
	/** Total runs, which can be more than `runs` holds. */
	runCount: number
	/** Already tagged with the email surface. */
	buttonUrl: string
	/** Signed stop link that switches off Flow activity email only. */
	stopUrl: string
}

export interface FlowActivityEmail {
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

export function flowRunLine(run: FlowActivityRun): string {
	return run.objectTitle
		? `${run.agentName} finished '${clip(run.objectTitle, 60)}'`
		: `${run.agentName} finished a task`
}

export function buildFlowActivityEmail(input: FlowActivityEmailInput): FlowActivityEmail {
	const { flowName, runs, runCount, buttonUrl, stopUrl } = input
	const name = clip(flowName, 60)
	const subject = runCount === 1 ? `${name}: 1 run finished` : `${name}: ${runCount} runs finished`
	const lines = runs.slice(0, MAX_FLOW_ACTIVITY_RUNS).map(flowRunLine)
	const more = runCount - lines.length
	if (more > 0) lines.push(`and ${more} more`)

	const text = [
		subject,
		'',
		...lines.map((l) => `- ${l}`),
		'',
		`Open the flow: ${buttonUrl}`,
		'',
		`Stop these emails: ${stopUrl}`,
	].join('\n')

	const html = [
		'<!doctype html>',
		'<html>',
		'<body style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif; color: #111; max-width: 560px; margin: 0 auto; padding: 24px;">',
		`<p style="font-size: 18px; font-weight: 600; margin: 0 0 8px;">${escapeHtml(subject)}</p>`,
		`<ul style="margin: 0; padding-left: 20px;">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`,
		`<p><a href="${escapeHtml(buttonUrl)}" style="display: inline-block; background: #111; color: #fff; padding: 12px 20px; border-radius: 6px; text-decoration: none;">Open the flow</a></p>`,
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
