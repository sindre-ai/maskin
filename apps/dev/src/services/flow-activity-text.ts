/**
 * flow-activity-text.ts — the Flow activity email, as pure functions.
 *
 * One mail names the flow and lists the runs that finished since the last mail for that flow, with
 * one button to the flow. Run lines read the way the summary email reads them. It says only that
 * runs finished: no result, no success claim, no AI call.
 */
import { button, clipAtWord as clip, headline, renderEmail, tickList } from './email-layout'

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

	const html = renderEmail({
		// The first run line says something the subject does not.
		preheader: lines[0] ?? subject,
		blocks: [headline(subject), tickList(lines), button(buttonUrl, 'Open the flow')],
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
