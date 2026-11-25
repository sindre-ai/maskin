// Shared constants for the Accounting marketplace bundle (slug accounting-loop).
//
// The bundle contains the Bookkeeper, plus every trigger and skill attached to it. Its snapshot
// data is written to be workspace-neutral and lives in data/accounting-*.json. The Dinero
// connection is not shipped: the installer connects Dinero under Settings, Integrations after
// install, by the steps in the accounting-connection-check skill.
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	ACCOUNTING_LOOP_ACTOR_BOOKKEEPER,
	ACCOUNTING_LOOP_DESCRIPTION,
	ACCOUNTING_LOOP_NAME,
	ACCOUNTING_LOOP_SLUG,
	ACCOUNTING_LOOP_USE_CASE,
	ACCOUNTING_LOOP_VERSION,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'
import type { LoopChecklist, LoopSettings } from './loop-settings'

// The setup checklist install turns into tasks: one parent and one child per prerequisite, all
// driven by the Bookkeeper. Wording is workspace-neutral. Each child needs the Bookkeeper's own
// method or the owner's own books, so none of them could sit on another flow's list.
const ACCOUNTING_CHECKLIST: LoopChecklist = {
	title: 'Accounting setup checklist',
	body: 'Everything the flow needs before it can turn receipts into draft vouchers without help. Each child task is one prerequisite. Work every open child until all are done or discarded, ask the owner at most 3 questions at a time, and report setup done only when every child is done or discarded.',
	driverSourceItemId: ACCOUNTING_LOOP_ACTOR_BOOKKEEPER,
	items: [
		{
			title: 'Connect Dinero',
			body: 'Needed: Dinero connected under Settings, Integrations, by the steps in the skill accounting-connection-check. This needs the owner to sign in once with their own Dinero user (a Dinero Pro or Total plan), so you cannot do it. Tell the owner what to do in plain words, one step at a time, and never ask for or look at a sign-in token.',
		},
		{
			title: 'Run the first connection check',
			body: 'Needed: the connection check from the skill accounting-connection-check run once with no receipt. It must read the right company, show only Dinero tools on the allowed list, and offer no tool that books, changes, deletes, pays or sends. Do it as soon as Dinero is connected. If it fails, say the line that fits the failure and what the owner must do.',
		},
		{
			title: 'Say which Dinero plan you have',
			body: 'Needed: which Dinero plan the company is on, so the flow knows what it can rely on. Look at what the connection shows first, then ask the owner to confirm your best guess.',
		},
		{
			title: 'Upload one test receipt',
			body: "Needed: one real receipt, a photo or a PDF, uploaded in the flow's chat. Save it as a draft voucher by the skill bookkeeping-draft-method, then show the owner the draft in Dinero and what is on the owner list. Nothing is booked. Done once the owner has seen the draft and said it looks right or what to change.",
		},
		{
			title: 'Confirm the financial year end',
			body: "Needed: the date the company's financial year ends, so drafts land in the right accounting year. Read the accounting years Dinero lists, propose the year end they show, and ask the owner only to confirm it.",
		},
		{
			title: 'Confirm the VAT period',
			body: 'Needed: how often the company reports VAT (monthly, quarterly or half-yearly), so the VAT lines on a draft are checked against the right period. Propose a guess from the VAT types and past vouchers Dinero shows, and ask the owner only to confirm it.',
		},
	],
}

// What the flow page shows beside the tabs. No targets ship: no bundled trigger keeps a target's
// actual current under a fixed label.
const ACCOUNTING_LOOP_SETTINGS: LoopSettings = {
	checklist: ACCOUNTING_CHECKLIST,
	entryCondition:
		"A person uploads a receipt, a photo or a PDF, in the flow's chat, and Dinero is connected.",
	closeCondition:
		'The receipt is saved as a draft voucher in Dinero, or it is on the owner list with the reason. Nothing is booked, changed or deleted by the flow.',
	tags: ['Finance'],
}

export const ACCOUNTING_LOOP = {
	slug: ACCOUNTING_LOOP_SLUG,
	name: ACCOUNTING_LOOP_NAME,
	version: ACCOUNTING_LOOP_VERSION,
	useCase: ACCOUNTING_LOOP_USE_CASE,
	settings: ACCOUNTING_LOOP_SETTINGS,
	description: ACCOUNTING_LOOP_DESCRIPTION,
} as const

export const ACCOUNTING_LOOP_ACTOR_IDS = [ACCOUNTING_LOOP_ACTOR_BOOKKEEPER] as const

export const ACCOUNTING_LOOP_TRIGGER_IDS: readonly string[] =
	ACCOUNTING_LOOP_ACTOR_IDS.flatMap(triggerIdsForActor)

export const ACCOUNTING_LOOP_SKILL_IDS: readonly string[] = [
	...new Set(ACCOUNTING_LOOP_ACTOR_IDS.flatMap(skillIdsForActor)),
]
