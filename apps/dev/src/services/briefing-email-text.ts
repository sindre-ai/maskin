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
import { MAX_FINISHED_RUNS } from './briefing-push-scheduler'
import type { BriefingText, FinishedFlow } from './briefing-push-scheduler'
import {
	bigNumber,
	button,
	clipAtWord as clip,
	headline,
	linkRow,
	nextStepLine,
	renderEmail,
	sectionHeading,
	softBox,
	tickList,
	waitingRow,
} from './email-layout'

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

export function buttonLabel(summary: BriefingText): string {
	return summary.waiting > 0 ? 'Open it' : 'Open Maskin'
}

export interface Section {
	kind: 'done' | 'waiting' | 'next'
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
		sections.push({
			kind: 'done',
			heading: `Done for you${where}`,
			lines: [...lines, ...runLines],
		})
	}

	// The count is the mail's title ("3 things need you"), so this part only adds what the title does not.
	if (summary.waiting > 0) {
		const lines: string[] = []
		if (summary.topHeadline) lines.push(`Starting with: ${clip(summary.topHeadline, 90)}`)
		if (summary.waitingElsewhere) lines.push(`${summary.waitingElsewhere} more in other workspaces`)
		if (lines.length > 0)
			sections.push({ kind: 'waiting', heading: `Waiting on you${where}`, lines })
	}

	if (nextStep) sections.push({ kind: 'next', heading: 'Next step', lines: [nextStep] })
	return sections
}

/** The hidden inbox preview: the first line of content that is not the subject. */
function summaryPreheader(summary: BriefingText, sections: Section[], lesson: string | null) {
	const order = ['waiting', 'done', 'next'] as const
	const lines = order.flatMap((kind) => sections.find((s) => s.kind === kind)?.lines ?? [])
	return (
		lines.find((l) => l !== summary.title) ?? lesson ?? 'See what is waiting for you in Maskin.'
	)
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

	// Reading order in the mail: the headline moment, what waits, what finished, the next step.
	const part = (kind: Section['kind']) => sections.find((s) => s.kind === kind)
	const waiting = part('waiting')
	const done = part('done')
	const next = part('next')
	const blocks = [
		summary.waiting > 0
			? bigNumber(summary.waiting, summary.waiting === 1 ? 'thing needs you' : 'things need you')
			: headline(summary.title),
		...(waiting ? [sectionHeading(waiting.heading), ...waiting.lines.map(waitingRow)] : []),
		...(done ? [sectionHeading(done.heading), tickList(done.lines)] : []),
		...(next ? [sectionHeading(next.heading), ...next.lines.map(nextStepLine)] : []),
		...(lesson ? [softBox(lesson)] : []),
		button(buttonUrl, label),
		...(pick
			? [
					sectionHeading('Marketplace pick'),
					softBox([
						`${pick.name}: ${pickDescription}`,
						`Why you see this: ${pick.why}`,
						'Setup and cost are on its Marketplace page.',
					]),
					linkRow([
						{ url: pick.url, label: 'See the flow' },
						{ url: pick.dismissUrl, label: 'Not useful' },
					]),
				]
			: []),
	]
	const html = renderEmail({
		preheader: summaryPreheader(summary, sections, lesson),
		blocks,
		stopUrl,
	})

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
