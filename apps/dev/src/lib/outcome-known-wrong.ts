/**
 * The known-wrong set of the outcome check: ten pieces of work, each with one line its own text
 * contradicts. The checker must send at least 8 of the 10 back. Run by
 * scripts/outcome-known-wrong.ts against a real model, with the counts stored as an event.
 */

export interface KnownWrongPiece {
	title: string
	content: string
	/** Three lines; the one at falseIndex is false against the content. */
	lines: string[]
	falseIndex: number
}

export const KNOWN_WRONG_PASS_MARK = 8

export const KNOWN_WRONG_SET: KnownWrongPiece[] = [
	{
		title: 'Outreach summary',
		content:
			'We sent 6 emails to the pilot list on Monday. 2 replied. We logged all 6 in the CRM and filed no report yet.',
		lines: [
			'At least 10 emails were sent',
			'Every email is logged in the CRM',
			'Replies are counted',
		],
		falseIndex: 0,
	},
	{
		title: 'Pricing page copy',
		content:
			'Headline: Plans for small teams. Three plans are listed: Free, Team and Business. The Team plan costs 29 euros a month. No annual discount is mentioned.',
		lines: [
			'Three plans are listed',
			'The Team plan price is shown',
			'An annual discount is explained',
		],
		falseIndex: 2,
	},
	{
		title: 'Release notes 4.2',
		content:
			'4.2 adds dark mode and fixes the export crash. Known issue: search is slow on very large workspaces. Upgrade steps: none needed.',
		lines: [
			'Dark mode is listed as new',
			'Known issues are listed',
			'Upgrade steps list the database migration',
		],
		falseIndex: 2,
	},
	{
		title: 'Interview notes, Dana',
		content:
			'Dana runs ops at a 12 person agency. She uses spreadsheets for reporting and wants weekly summaries. She did not mention budget. No follow-up date was set.',
		lines: [
			'The role and company size are noted',
			'Her budget is recorded',
			'A follow-up date is set',
		],
		falseIndex: 2,
	},
	{
		title: 'Incident review',
		content:
			'On 3 Nov the API was down for 40 minutes. Cause: an expired certificate. Fix: renewed the certificate. Prevention: not decided yet.',
		lines: [
			'The duration is stated',
			'The cause is stated',
			'A prevention step is named and owned',
		],
		falseIndex: 2,
	},
	{
		title: 'Launch checklist',
		content:
			'Done: domain connected, analytics installed, privacy page published. Not done: cookie banner, status page.',
		lines: [
			'The domain is connected',
			'The cookie banner is live',
			'The privacy page is published',
		],
		falseIndex: 1,
	},
	{
		title: 'Webinar recap',
		content:
			'The webinar ran for 45 minutes with 31 live attendees. Recording is not yet uploaded. Slides were shared in the chat.',
		lines: ['Attendance is stated', 'The recording link is included', 'Slides were shared'],
		falseIndex: 1,
	},
	{
		title: 'Competitor scan',
		content:
			'We looked at two competitors, Alpha and Beta. Alpha has a free tier; Beta does not. We did not look at pricing for enterprise plans.',
		lines: [
			'At least three competitors are covered',
			'Free tier availability is noted',
			'Alpha and Beta are named',
		],
		falseIndex: 0,
	},
	{
		title: 'Support macro',
		content:
			'Hi, thanks for writing in. We have reset your password. Please check your inbox. Best, Support. This message does not include a link to the help centre.',
		lines: [
			'It greets and thanks the customer',
			'It links to the help centre',
			'It says the password was reset',
		],
		falseIndex: 1,
	},
	{
		title: 'Quarterly goals',
		content:
			'Goal 1: reach 200 signups. Goal 2: cut churn to 3 percent. Each goal has an owner. No goal has a deadline yet.',
		lines: ['Each goal has an owner', 'Each goal has a deadline', 'There are two goals'],
		falseIndex: 1,
	},
]
