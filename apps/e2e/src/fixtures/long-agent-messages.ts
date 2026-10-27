/**
 * Three long agent chat messages for the object-card tests, each linking 5 to 10 objects.
 *
 * Their shape comes from real long agent replies: how many links, where they sit (own line,
 * bullet, table cell, inside a sentence), how many paragraphs and lists, and how long the text is.
 * Everything else is made up. This repo is open source, so no title, name, id or business content
 * from a real workspace is here. Object titles are invented, and the people and teams in the
 * prose are not real.
 *
 * A body names its objects as {{key}}. The test creates one object per entry in `objects`, then
 * `renderLongMessage` swaps each {{key}} for that object's in-app address.
 */

export interface FixtureObject {
	key: string
	type: 'bet' | 'task' | 'insight' | 'knowledge'
	title: string
	status: string
	/** Plain words, one to three sentences: what a card shows under the title. */
	content: string
	/** A message a person approves before it goes out: made as a task an integration can deliver. */
	draft?: boolean
}

export interface LongAgentMessage {
	name: string
	/** What real message the shape was taken from, for whoever adds the next fixture. */
	shape: string
	objects: FixtureObject[]
	body: string
}

/** Replaces each {{key}} in the body with the address of the object created for that key. */
export function renderLongMessage(
	message: LongAgentMessage,
	workspaceId: string,
	idsByKey: Record<string, string>,
): string {
	return message.body.replace(/\{\{([\w-]+)\}\}/g, (_, key: string) => {
		const id = idsByKey[key]
		if (!id) throw new Error(`Fixture "${message.name}" has no object for {{${key}}}`)
		return `/${workspaceId}/objects/${id}`
	})
}

/** Six links: four in a bullet list, two in a short paragraph. Two long paragraphs around them. */
export const STATUS_REPORT_MESSAGE: LongAgentMessage = {
	name: 'status report with a bullet list',
	shape:
		'Opening paragraph of four sentences, a four-item bullet list with a link and a clause each, a paragraph with two links in it, a two-item list of decisions, one closing question.',
	objects: [
		{
			key: 'harbor',
			type: 'bet',
			title: 'Harbor lights for the night shift',
			status: 'signal',
			content: 'Night-shift workers get a calmer view of what needs them, with fewer alerts.',
		},
		{
			key: 'quiet',
			type: 'bet',
			title: 'Quiet hours that really are quiet',
			status: 'signal',
			content: 'Pick the hours when only the urgent things may reach you.',
		},
		{
			key: 'ferry',
			type: 'bet',
			title: 'One ferry for every device',
			status: 'define',
			content:
				'Every signed-in device gets its own key, so one lost device does not log out the rest.',
		},
		{
			key: 'lantern',
			type: 'bet',
			title: 'Lantern view of waiting work',
			status: 'signal',
			content: 'A single list of the work that is waiting on you and who it came from.',
		},
		{
			key: 'old-dock',
			type: 'bet',
			title: 'Old dock cleanup',
			status: 'signal',
			content: 'Folded into the ferry bet. It can be restored.',
		},
		{
			key: 'small-boats',
			type: 'bet',
			title: 'Small boats, small fixes',
			status: 'signal',
			content: 'Nine small pieces, now a list in the spec.',
		},
	],
	body: [
		'Hey Mia, the harbor bets are now shared features instead. Most of what the screens need already exists on the web app and the phone: five of the sixteen, including handed-off work. Eight need new shared backend or web work, one is phone-only, and two belong to the small device alone. That count comes from reading code only, nobody ran a build or a device.',
		'Four bets remain, all still at the starting status, and the small device is listed as one user in each:',
		[
			'- [Harbor lights for the night shift]({{harbor}}): every alert says what happened in one line, on the phone, the web and the device.',
			'- [Quiet hours that really are quiet]({{quiet}}): you choose what may interrupt you. The web has no such page today.',
			'- [One ferry for every device]({{ferry}}): this now includes the old sign-in work.',
			'- [Lantern view of waiting work]({{lantern}}): web and phone already have most of it, so I would keep it parked.',
		].join('\n'),
		'Two bets are archived and can be restored: [Old dock cleanup]({{old-dock}}) and [Small boats, small fixes]({{small-boats}}). The smaller pieces are now a list in the new spec, which also has the screen-by-screen table. The tech lead has not reviewed the spec yet.',
		[
			'Two calls are yours:',
			'- The design promises a one-hour undo, but the phone app only has a six-second one. Do you want the one-hour version?',
			'- Urgent items now break through quiet hours only when you turn that on. The old spec said on, which contradicted its own rule.',
		].join('\n'),
		'I would promote the alerts bet first. Want me to ask the planner to do that once the tech lead signs off?',
	].join('\n\n'),
}

/** Seven links: five in a table, one on its own line, one inside a sentence. */
export const REVIEW_TABLE_MESSAGE: LongAgentMessage = {
	name: 'review summary with a table',
	shape:
		'Two-sentence opening, a five-row table with a link in the first cell of each row, a link alone on its own line, a bulleted list of caveats, one link inside a closing sentence.',
	objects: [
		{
			key: 'bridge',
			type: 'task',
			title: 'Bridge the two sign-in screens',
			status: 'in_review',
			content: 'Both screens now share one set of words and one error message.',
		},
		{
			key: 'tide',
			type: 'task',
			title: 'Tide table for the weekly digest',
			status: 'in_progress',
			content: 'The digest lists what changed since last Monday, grouped by owner.',
		},
		{
			key: 'anchor',
			type: 'task',
			title: 'Anchor the sidebar on small screens',
			status: 'todo',
			content: 'The sidebar keeps its place when the keyboard opens on a phone.',
		},
		{
			key: 'compass',
			type: 'insight',
			title: 'People lose their place after a long reply',
			status: 'new',
			content:
				'Three people said they scroll back up to find the thing the agent was talking about.',
		},
		{
			key: 'chart',
			type: 'knowledge',
			title: 'How the weekly digest is built',
			status: 'draft',
			content: 'The digest is built each Monday from the objects changed in the last seven days.',
		},
		{
			key: 'beacon',
			type: 'bet',
			title: 'Beacon for blocked work',
			status: 'active',
			content: 'Blocked work shows who it waits on and for how long.',
		},
		{
			key: 'rudder',
			type: 'task',
			title: 'Rudder for the retry button',
			status: 'backlog',
			content: 'The retry button remembers what you were doing before it failed.',
		},
	],
	body: [
		'The review pass is done for this week. Five tasks and one page were checked, and one of them needs another look before it ships.',
		[
			'| Item | State | Note |',
			'| --- | --- | --- |',
			'| [Bridge the two sign-in screens]({{bridge}}) | Ready | Words match on both screens |',
			'| [Tide table for the weekly digest]({{tide}}) | Needs work | Groups by owner, not by team |',
			'| [Anchor the sidebar on small screens]({{anchor}}) | Not started | Waiting on the design check |',
			'| [People lose their place after a long reply]({{compass}}) | Open | Three reports so far |',
			'| [How the weekly digest is built]({{chart}}) | Draft | Needs a sentence on time zones |',
		].join('\n'),
		'The one I would look at first is this one:\n[Beacon for blocked work]({{beacon}})',
		[
			'Things I could not check:',
			'- I read the code and the tests, but I did not run the app on a phone.',
			'- The digest was only tried on the small sample set, not on a full week.',
			'- The two sign-in screens were checked in the light theme only.',
		].join('\n'),
		'Once the sidebar work starts, [Rudder for the retry button]({{rudder}}) can follow it, since both touch the same file.',
	].join('\n\n'),
}

/** Ten links, each a sentence followed by the link alone on its own line. The clutter case. */
export const TEN_LINK_MESSAGE: LongAgentMessage = {
	name: 'ten links, each on its own line',
	shape:
		'An audit that names ten objects one after another: a short opening, then ten short paragraphs of one sentence plus the link alone on the next line, then a two-sentence close.',
	objects: [
		{
			key: 'l1',
			type: 'bet',
			title: 'North pier signup flow',
			status: 'active',
			content: 'New people reach their first chat in under two minutes.',
		},
		{
			key: 'l2',
			type: 'bet',
			title: 'South pier billing page',
			status: 'active',
			content: 'One page shows what you pay for and what is left this month.',
		},
		{
			key: 'l3',
			type: 'task',
			title: 'Paint the empty states',
			status: 'in_progress',
			content: 'Every empty list says what it is for and how to fill it.',
		},
		{
			key: 'l4',
			type: 'task',
			title: 'Rename the import button',
			status: 'todo',
			content: 'The button says Import file, because that is what it does.',
		},
		{
			key: 'l5',
			type: 'task',
			title: 'Check the focus ring on links',
			status: 'in_review',
			content: 'Keyboard focus is visible on every link in the chat.',
		},
		{
			key: 'l6',
			type: 'insight',
			title: 'Reports are hard to find after a week',
			status: 'new',
			content: 'Two people asked where the report from last week went.',
		},
		{
			key: 'l7',
			type: 'insight',
			title: 'The mobile menu hides the new chat button',
			status: 'new',
			content: 'On a narrow phone the button sits under the keyboard.',
		},
		{
			key: 'l8',
			type: 'knowledge',
			title: 'Words we use for waiting work',
			status: 'draft',
			content: 'Waiting means someone else has to act. Blocked means nobody can act yet.',
		},
		{
			key: 'l9',
			type: 'knowledge',
			title: 'How a draft becomes a sent email',
			status: 'draft',
			content: 'A draft is approved by a person, then sent by the sender agent.',
		},
		{
			key: 'l10',
			type: 'task',
			title: 'Archive the old pier notes',
			status: 'backlog',
			content: 'The notes are moved to the archive and linked from the new page.',
		},
	],
	body: [
		'I went through everything that touches the first-week experience. These are the ten things that came up, in the order I found them.',
		'The signup flow is the biggest lever.\n[North pier signup flow]({{l1}})',
		'Billing sits right next to it.\n[South pier billing page]({{l2}})',
		'Empty lists are the first thing a new person sees.\n[Paint the empty states]({{l3}})',
		'One button name is wrong.\n[Rename the import button]({{l4}})',
		'Keyboard users cannot see where they are.\n[Check the focus ring on links]({{l5}})',
		'Two people lost a report.\n[Reports are hard to find after a week]({{l6}})',
		'A phone problem too.\n[The mobile menu hides the new chat button]({{l7}})',
		'Two pages to read before touching any of it.\n[Words we use for waiting work]({{l8}})',
		'[How a draft becomes a sent email]({{l9}})',
		'Last, some cleanup.\n[Archive the old pier notes]({{l10}})',
		'None of this needs a decision from you today. Tell me which one to start with and I will hand it on.',
	].join('\n\n'),
}

/**
 * The long message in the designer's clickable prototype: a short opening, four bets each alone
 * on a line, the build task and a page each alone on a line, a draft for approval, a closing line.
 * Every title and text is invented here. The prototype's contact is left out: it is an object like
 * any other to the card, and this workspace has no contact type.
 */
export const PROTOTYPE_LONG_MESSAGE: LongAgentMessage = {
	name: 'prototype long message',
	shape:
		'Opening of two sentences, a lead-in line and four bets each alone on a line, a lead-in line and a task and a page each alone on a line, a lead-in line and a draft alone on a line, one closing sentence.',
	objects: [
		{
			key: 'p1',
			type: 'bet',
			title: 'Weather vane for the weekly plan',
			status: 'define',
			content:
				'The weekly plan shows which way the week is leaning, so people see changes before they hit.',
		},
		{
			key: 'p2',
			type: 'bet',
			title: 'Lighthouse tags for page titles',
			status: 'active',
			content: 'Pages carry a clear title when someone pastes the address into another tool.',
		},
		{
			key: 'p3',
			type: 'bet',
			title: 'Ledger that agrees to the cent',
			status: 'active',
			content: 'Totals on the dashboard and in the export match, down to the last digit.',
		},
		{
			key: 'p4',
			type: 'bet',
			title: 'One stamp per chat',
			status: 'active',
			content: 'A stamp no longer repeats under every message in the same chat.',
		},
		{
			key: 'p5',
			type: 'task',
			title: 'Place the stamp by how many links a message has',
			status: 'in_progress',
			content: 'Count the links when the message is placed. Nothing changes size after it loads.',
		},
		{
			key: 'p6',
			type: 'knowledge',
			title: 'What counts as a win for the stamp bet',
			status: 'draft',
			content: 'A win is a clean run at three widths. A loss is one complaint about clutter.',
		},
		{
			key: 'p7',
			type: 'task',
			title: 'Reply to the harbour office about timing',
			status: 'todo',
			content: 'Hello, thanks for the quick answer. We can start on the ninth with a team of six.',
			draft: true,
		},
	],
	body: [
		'Short version: the bet is at the first stage and the design is the last open item. Everything below is linked so you can open it.',
		'Related bets in flight:',
		'[Weather vane for the weekly plan]({{p1}})',
		'[Lighthouse tags for page titles]({{p2}})',
		'[Ledger that agrees to the cent]({{p3}})',
		'[One stamp per chat]({{p4}})',
		'The open build task and the page with the win and loss rules:',
		'[Place the stamp by how many links a message has]({{p5}})',
		'[What counts as a win for the stamp bet]({{p6}})',
		'The harbour office asked about timing, so I drafted the reply. It needs your yes:',
		'[Reply to the harbour office about timing]({{p7}})',
		'Nothing else is blocked on you.',
	].join('\n\n'),
}

/**
 * A draft sits between plain objects, each alone on a line. A draft shares the cap of three
 * cards a message with the other cards, so the bet, the draft and the task are drawn and the two
 * links after them are chips.
 */
export const DRAFT_IN_CAP_MESSAGE: LongAgentMessage = {
	name: 'a draft among five objects on their own lines',
	shape:
		'One opening sentence, then five links each alone on a line with a short lead-in, the second of them a draft, then one closing sentence.',
	objects: [
		{
			key: 'c1',
			type: 'bet',
			title: 'Raft for the quiet weekend',
			status: 'active',
			content: 'Weekend alerts only reach you when something is on fire.',
		},
		{
			key: 'c2',
			type: 'task',
			title: 'Note to the dock manager',
			status: 'todo',
			content: 'Hello, could we move the handover to Tuesday? It fits the delivery better.',
			draft: true,
		},
		{
			key: 'c3',
			type: 'task',
			title: 'Count the spare keys',
			status: 'in_progress',
			content: 'Check the cabinet and write down how many are missing.',
		},
		{
			key: 'c4',
			type: 'insight',
			title: 'Handover notes get lost on Fridays',
			status: 'new',
			content: 'Two people said the Friday notes were gone by Monday.',
		},
		{
			key: 'c5',
			type: 'knowledge',
			title: 'How the weekend rota works',
			status: 'draft',
			content: 'The rota is set on Wednesday and shared with everyone on the team.',
		},
	],
	body: [
		'Five things came up while I went through the weekend plan.',
		'The big one first:\n[Raft for the quiet weekend]({{c1}})',
		'This needs your yes before it goes out:\n[Note to the dock manager]({{c2}})',
		'A small job to start on:\n[Count the spare keys]({{c3}})',
		'Something people told us:\n[Handover notes get lost on Fridays]({{c4}})',
		'The page to read first:\n[How the weekend rota works]({{c5}})',
		'Tell me which one to pick up and I will hand it on.',
	].join('\n\n'),
}

export const LONG_AGENT_MESSAGES: LongAgentMessage[] = [
	STATUS_REPORT_MESSAGE,
	REVIEW_TABLE_MESSAGE,
	TEN_LINK_MESSAGE,
]
