/**
 * briefing-email-text.ts — the summary email, as pure functions.
 *
 * Every mail has three parts: what finished for the person since the last mail (runs of a flow
 * grouped per flow, up to 3 flows, then up to 5 runs that tie to no flow, newest first, each
 * list followed by "and N more"), what waits on them, and one next-step line. The facts and
 * their wording come from the daily briefing push (`buildBriefingText`), so an email never says a
 * different number than the push or the For You screen. No AI call, no message bodies: only the
 * titles the push already shows.
 *
 * Steps 1 to 3 (the first three mails anyone gets, new or existing) also carry one short lesson
 * each (a card, a flow, your results), plain how-to and no offers. After that the mail is the plain daily summary.
 */
import { MAX_FINISHED_RUNS, clip } from './briefing-push-scheduler'
import type { BriefingText, FinishedFlow } from './briefing-push-scheduler'

/** Most flows named in the finished part; the rest fold into "and N more flows". */
export const MAX_FINISHED_FLOWS = 3

export type EmailStep = 1 | 2 | 3 | 'daily'

/**
 * The lesson per onboarding step: step 1 a card, step 2 a flow, step 3 your results. Plain help for
 * every role; nothing here may promise an unbuilt feature. The daily mail carries none.
 */
export const STEP_LESSON: Record<1 | 2 | 3, string> = {
	1: 'A card is something an agent needs from you: a decision, a draft to check or an answer. When one is waiting, the button below opens it.',
	2: 'A flow is a team of agents that keeps working on a job for you, on a schedule or when something happens. The Flows page shows what yours are doing.',
	3: 'Open any result you have not seen yet. You can reply to the agent in chat.',
}

/**
 * Pure: the one next-step line, or null. In order: a card waits on you, then open it; else you have
 * no loop yet, then create your first one; else nothing. (A rule for "a finished run you have not
 * opened" is left out: the app does not store whether a run was opened.)
 */
export function pickNextStep(facts: { waiting: number; hasLoop: boolean }): string | null {
	if (facts.waiting > 0) {
		return facts.waiting === 1 ? 'Open the card that needs you.' : 'Open the card at the top first.'
	}
	if (!facts.hasLoop) return 'Create your first loop, a routine your agents repeat for you.'
	return null
}

export interface SummaryEmailInput {
	summary: BriefingText
	step: EmailStep
	/** Where the button goes: the top waiting card, or the workspace home. Already tagged. */
	buttonUrl: string
	/** Signed stop link; the one-click header points at the same URL. */
	stopUrl: string
	/** From pickNextStep; null leaves the part out. */
	nextStep: string | null
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

export interface Section {
	heading: string
	lines: string[]
}

function runLine(run: { agentName: string; objectTitle: string | null }): string {
	return run.objectTitle
		? `${run.agentName} finished '${clip(run.objectTitle, 60)}'`
		: `${run.agentName} finished a task`
}

/** Says only that runs finished; never what they produced or whether they went well. */
function flowLine(flow: FinishedFlow): string {
	const count = `${flow.runs} ${flow.runs === 1 ? 'run' : 'runs'} finished`
	const latest = flow.latestTitle ? `, latest '${clip(flow.latestTitle, 60)}'` : ''
	return `${clip(flow.flowName, 60)}: ${count}${latest}`
}

/** The parts that hold content; a part with nothing to say is left out. */
export function summarySections(summary: BriefingText, nextStep: string | null): Section[] {
	const sections: Section[] = []
	const where =
		summary.multiWorkspace && summary.workspaceName ? ` in ${summary.workspaceName}` : ''

	const runs = summary.finishedRuns ?? []
	const flows = summary.finishedFlows ?? []
	if (summary.finished > 0) {
		const lines = flows.slice(0, MAX_FINISHED_FLOWS).map(flowLine)
		const moreFlows = flows.length - lines.length
		if (moreFlows > 0) lines.push(`and ${moreFlows} more ${moreFlows === 1 ? 'flow' : 'flows'}`)

		// Runs that tie to no flow stay in the plain list.
		const untied = summary.finished - flows.reduce((sum, f) => sum + f.runs, 0)
		const runLines = runs.slice(0, MAX_FINISHED_RUNS).map(runLine)
		const more = untied - runLines.length
		if (runLines.length === 0 && untied > 0) {
			runLines.push(`${untied} agent ${untied === 1 ? 'run' : 'runs'} finished`)
		} else if (more > 0) {
			runLines.push(`and ${more} more`)
		}
		sections.push({ heading: `Done for you${where}`, lines: [...lines, ...runLines] })
	}

	if (summary.waiting > 0) {
		const lines = [
			summary.waiting === 1 ? '1 thing needs you' : `${summary.waiting} things need you`,
		]
		if (summary.topHeadline) lines.push(`Starting with: ${clip(summary.topHeadline, 90)}`)
		if (summary.waitingElsewhere) lines.push(`${summary.waitingElsewhere} more in other workspaces`)
		sections.push({ heading: `Waiting on you${where}`, lines })
	}

	if (nextStep) sections.push({ heading: 'Next step', lines: [nextStep] })
	return sections
}

export function buildSummaryEmail(input: SummaryEmailInput): SummaryEmail {
	const { summary, step, buttonUrl, stopUrl, nextStep } = input
	const lesson = step === 'daily' ? null : STEP_LESSON[step]
	const label = buttonLabel(summary)
	const sections = summarySections(summary, nextStep)

	const text = [
		summary.title,
		...sections.flatMap((s) => ['', s.heading, ...s.lines.map((l) => `- ${l}`)]),
		...(lesson ? ['', lesson] : []),
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
		...sections.map(
			(s) =>
				`<p style="margin: 16px 0 4px; font-weight: 600;">${escapeHtml(s.heading)}</p><ul style="margin: 0; padding-left: 20px;">${s.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`,
		),
		...(lesson ? [`<p style="color: #444; margin: 16px 0;">${escapeHtml(lesson)}</p>`] : []),
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
