/**
 * briefing-email-text.ts — the digest email, as pure functions.
 *
 * One mail a day (or a week) of what the person has not dealt with, in two parts. "Needs you" is
 * what waits on a decision or a reply, at most three rows, each with its own button. "Updates" is
 * the person's other unread notifications in three groups (Objects, Flows, Chats), one line each,
 * at most five rows a group. Below the list: the next-step line and, in the first three mails, one
 * short lesson. Then one "Open Maskin" button. The rows come from digest-email-data.ts. No AI
 * call, and no message text: a chat row is the chat's name and how many new messages.
 */
import type {
	DigestData,
	DigestGroup,
	DigestUpdateRow,
	DigestWaitingRow,
} from './digest-email-data'
import {
	button,
	clipAtWord as clip,
	countHeading,
	headline,
	linkRow,
	moreLink,
	needBox,
	nextStepLine,
	renderEmail,
	sectionHeading,
	softBox,
	spacer,
	updateRows,
} from './email-layout'

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
	digest: DigestData
	step: EmailStep
	/** Workspace-less app address, like https://app.maskin.io, without a trailing slash. */
	appUrl: string
	/** The person's IANA timezone; times in the mail are in it. */
	timezone: string
	now: Date
	/** The person's send time as "07:30", named in the footer. */
	sendTime: string
	/** "weekly" changes the footer to say one email a week; anything else says a day. */
	rhythm: string | null
	/** The "Open Maskin" button, already tagged. */
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

export const BUTTON_LABEL = 'Open Maskin'

/**
 * The subject and the heading. Both parts: "2 need you, 5 other updates". Only updates: "5 updates".
 * Only waiting items: "2 need you". One of a kind reads "1 needs you", "1 update", "1 other update".
 */
export function digestSubject(waiting: number, updates: number): string {
	const need = waiting === 1 ? '1 needs you' : `${waiting} need you`
	if (waiting > 0 && updates > 0) {
		return `${need}, ${updates} other ${updates === 1 ? 'update' : 'updates'}`
	}
	if (waiting > 0) return need
	return `${updates} ${updates === 1 ? 'update' : 'updates'}`
}

function timeParts(at: Date, timezone: string, withWeekday: boolean): string {
	const options: Intl.DateTimeFormatOptions = {
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
		...(withWeekday ? { weekday: 'short' } : {}),
	}
	try {
		return new Intl.DateTimeFormat('en-US', { ...options, timeZone: timezone })
			.format(at)
			.replace(',', '')
	} catch {
		return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' })
			.format(at)
			.replace(',', '')
	}
}

function localDay(at: Date, timezone: string): string {
	try {
		return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(at)
	} catch {
		return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(at)
	}
}

/** "09:12" for today, "Tue 09:12" for another day. */
export function clockLabel(at: Date, now: Date, timezone: string): string {
	return timeParts(at, timezone, localDay(at, timezone) !== localDay(now, timezone))
}

function whenLabel(row: DigestWaitingRow, now: Date, timezone: string): string {
	return row.dueAt
		? `Due ${timeParts(row.dueAt, timezone, true)}`
		: `Asked ${clockLabel(row.at, now, timezone)}`
}

const GROUP_LABELS: Record<DigestGroup['kind'], string> = {
	objects: 'Objects',
	flows: 'Flows',
	chats: 'Chats',
}

/** The hidden inbox preview: the first waiting item (or update) and how many more are unread. */
export function digestPreheader(digest: DigestData): string {
	const first = digest.waiting[0]?.title ?? digest.groups[0]?.rows[0]?.title
	const total = digest.waitingCount + digest.updatesCount
	if (!first) return 'See what is new in Maskin.'
	const rest = total - 1
	return rest > 0 ? `${first}, and ${rest} more unread.` : first
}

export function buildSummaryEmail(input: SummaryEmailInput): SummaryEmail {
	const { digest, step, appUrl, timezone, now, buttonUrl, stopUrl, nextStep, pick } = input
	const lesson = step === 'daily' ? null : STEP_LESSON[step]
	const subject = digestSubject(digest.waitingCount, digest.updatesCount)
	const pickDescription = pick ? clip(pick.description, 140) : ''
	const homeUrl = (block: string) =>
		`${appUrl}/${digest.anchorWorkspaceId ?? ''}?surface=email&block=${block}`.replace('//?', '/?')
	const rowUrl = (path: string, block: string) => `${appUrl}${path}?surface=email&block=${block}`
	const moreWaiting = digest.waitingCount - digest.waiting.length
	const period = input.rhythm === 'weekly' ? 'week' : 'day'
	const footerNote = `One email a ${period} instead of one per notification. It lists what is still unread when it goes out, at ${input.sendTime}.`

	const text = [
		subject,
		...(digest.waitingCount > 0
			? [
					'',
					`Needs you (${digest.waitingCount})`,
					...digest.waiting.flatMap((r) => [
						`- ${r.title}${r.line ? `: ${r.line}` : ''} [${r.typeLabel}, ${whenLabel(r, now, timezone)}]`,
						`  ${r.buttonLabel}: ${rowUrl(r.path, 'waiting')}`,
					]),
					...(moreWaiting > 0
						? [`${moreWaiting} more waiting for you in Maskin: ${homeUrl('waiting')}`]
						: []),
				]
			: []),
		...(digest.updatesCount > 0
			? [
					'',
					`Updates (${digest.updatesCount})`,
					...digest.groups.flatMap((g) => [
						'',
						`${GROUP_LABELS[g.kind]} (${g.count})`,
						...g.rows.flatMap((r) => [
							`- ${r.title}: ${r.line}, ${clockLabel(r.at, now, timezone)}`,
							`  ${rowUrl(r.path, 'updates')}`,
						]),
						...(g.count > g.rows.length
							? [`${g.count - g.rows.length} more in Maskin: ${homeUrl('updates')}`]
							: []),
					]),
				]
			: []),
		...(nextStep ? ['', 'Next step', `- ${nextStep}`] : []),
		...(lesson ? ['', lesson] : []),
		'',
		`${BUTTON_LABEL}: ${buttonUrl}`,
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
		footerNote,
		`Stop these emails: ${stopUrl}`,
	].join('\n')

	const needsYou =
		digest.waitingCount > 0
			? [
					countHeading('Needs you', digest.waitingCount),
					needBox(
						digest.waiting.map((r) => ({
							title: r.title,
							line: r.line,
							typeLabel: r.typeLabel,
							typeKind: r.typeKind,
							when: whenLabel(r, now, timezone),
							url: rowUrl(r.path, 'waiting'),
							buttonLabel: r.buttonLabel,
						})),
					),
					...(moreWaiting > 0
						? [moreLink(homeUrl('waiting'), `${moreWaiting} more waiting for you in Maskin`)]
						: []),
				]
			: []
	const updates =
		digest.updatesCount > 0
			? [
					countHeading('Updates', digest.updatesCount, true),
					...digest.groups.flatMap((g) => [
						countHeading(GROUP_LABELS[g.kind], g.count, true),
						updateRows(
							g.rows.map((r: DigestUpdateRow) => ({
								title: r.title,
								line: `${r.line}, ${clockLabel(r.at, now, timezone)}`,
								url: rowUrl(r.path, 'updates'),
							})),
						),
						...(g.count > g.rows.length
							? [moreLink(homeUrl('updates'), `${g.count - g.rows.length} more in Maskin`)]
							: []),
					]),
				]
			: []
	const blocks = [
		headline(subject),
		...needsYou,
		...updates,
		...(nextStep ? [sectionHeading('Next step'), nextStepLine(nextStep)] : []),
		...(lesson ? [softBox(lesson)] : []),
		spacer(),
		button(buttonUrl, BUTTON_LABEL),
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
		preheader: digestPreheader(digest),
		blocks,
		footerNote,
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
