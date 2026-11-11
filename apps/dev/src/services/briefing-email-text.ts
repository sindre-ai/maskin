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

/** Owners and admins get the setup steps; everyone else gets the plain ones. */
export type EmailRole = 'owner_admin' | 'member'

/** The `email_sent` role property value for a workspace role; anything not owner or admin is a member. */
export function emailRole(workspaceRole: string | null | undefined): EmailRole {
	return workspaceRole === 'owner' || workspaceRole === 'admin' ? 'owner_admin' : 'member'
}

export interface NextStepFacts {
	role: EmailRole
	/** Cards waiting on the person in the anchor workspace. */
	waiting: number
	/** The anchor workspace has at least one flow (a loop object). Only read for owners and admins. */
	hasFlow: boolean
	/** The person is the only human in the anchor workspace. Only read for owners and admins. */
	onlyMember: boolean
}

/**
 * Pure: the one next-step line, or null. Same input, same text, no I/O and no AI call.
 * Owner or admin, in order: a card waits, then open it; else no flow yet, then create your first;
 * else you are the only member, then invite a teammate; else nothing. Member: a card waits, then
 * open it; else nothing. (A rule for "a finished run you have not opened" is left out: the app
 * does not store whether a run was opened.)
 */
export function pickNextStep(facts: NextStepFacts): string | null {
	if (facts.waiting > 0) {
		return facts.waiting === 1 ? 'Open the card that needs you.' : 'Open the card at the top first.'
	}
	if (facts.role !== 'owner_admin') return null
	if (!facts.hasFlow) return 'Create your first flow, a routine your agents repeat for you.'
	if (facts.onlyMember) return 'Invite a teammate, so your agents can work for more than just you.'
	return null
}

/** The opt-in Marketplace pick block, placed below the summary. Plain help, no price talk. */
export interface PickBlock {
	name: string
	description: string
	/** The "Why you see this" sentence, without the prefix. */
	why: string
	/** The flow's Marketplace page, already tagged with surface=email. */
	url: string
	/** Signed "Not useful" link. */
	dismissUrl: string
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
	/** Only for someone who switched picks on, never in steps 1 to 3. Absent leaves the block out. */
	pick?: PickBlock | null
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
	const { summary, step, buttonUrl, stopUrl, nextStep, pick } = input
	const lesson = step === 'daily' ? null : STEP_LESSON[step]
	const label = buttonLabel(summary)
	const sections = summarySections(summary, nextStep)
	const pickDescription = pick ? clip(pick.description, 140) : ''

	const text = [
		summary.title,
		...sections.flatMap((s) => ['', s.heading, ...s.lines.map((l) => `- ${l}`)]),
		...(lesson ? ['', lesson] : []),
		'',
		`${label}: ${buttonUrl}`,
		...(pick
			? [
					'',
					'Marketplace pick',
					`- ${pick.name}: ${pickDescription}`,
					`- Why you see this: ${pick.why}`,
					'- Setup and cost are on its Marketplace page.',
					`See the flow: ${pick.url}`,
					`Not useful: ${pick.dismissUrl}`,
				]
			: []),
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
		...(pick
			? [
					`<p style="margin: 24px 0 4px; font-weight: 600;">Marketplace pick</p><ul style="margin: 0; padding-left: 20px;"><li>${escapeHtml(pick.name)}: ${escapeHtml(pickDescription)}</li><li>Why you see this: ${escapeHtml(pick.why)}</li><li>Setup and cost are on its Marketplace page.</li></ul>`,
					`<p><a href="${escapeHtml(pick.url)}" style="color: #111;">See the flow</a> &nbsp;·&nbsp; <a href="${escapeHtml(pick.dismissUrl)}" style="color: #666;">Not useful</a></p>`,
				]
			: []),
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
