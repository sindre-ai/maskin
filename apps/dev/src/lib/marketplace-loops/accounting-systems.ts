// The accounting-systems skill of the Accounting marketplace bundle. The Bookkeeper reads it to ask
// the owner which accounting system they use and to say how far that system connects. The list and
// every status come from ACCOUNTING_SYSTEMS in @maskin/shared, so a status lives in one place.
//
// Unlike the other bundle skills this one is built here, not captured into data/*.json, so the
// list cannot drift from the constant. It is merged into the skill lookup in ./loop-data.

import {
	ACCOUNTING_LOOP_ACTOR_BOOKKEEPER,
	ACCOUNTING_SYSTEMS,
	type AccountingSystemStatus,
} from '@maskin/shared'
import type { SkillData } from './loop-data'

// Template id of the skill, minted for this bundle. Install matches updates on it.
export const ACCOUNTING_SYSTEMS_SKILL_ID = '8847a6b5-65d1-47ca-b3f9-188c2fef8ed0'

const STATUS_LABEL: Record<AccountingSystemStatus, string> = {
	ready: 'Ready',
	needs_setup: 'Needs setup',
	not_yet: 'Not yet',
}

const systemLines = ACCOUNTING_SYSTEMS.map(
	(system) => `- ${system.name}: ${STATUS_LABEL[system.status]}. ${system.note}`,
).join('\n')

const content = `---
name: accounting-systems
description: Which accounting systems the owner can pick, how far each one connects, and what to do with the pick. Load at the start of every job and in the weekly connection check.
---

# Accounting systems

## Which system the owner uses

Look for a comment on the flow that starts with "Accounting system:". If there is one, that is the pick: carry on with it.

If there is none, this is the first job. Show the owner the list below, with each status, and ask which system they use. When they answer, post one short comment on the flow, "Accounting system: <name>", so every later job and the weekly check find it. Change it only when the owner asks.

## The list

${systemLines}

## What to do with the pick

- Ready: run the connection check for that system, then do the job.
- Needs setup: tell the owner the line above in plain words, and stop until they have done it. Then run the connection check.
- Not yet: say plainly that this system cannot connect yet and nothing was saved. Tell the owner they can pick another system from the list. Do not try to work around it.

Today the connection check, in the skill accounting-connection-check, exists for Dinero only. Read from and save to the picked system only, never another one.

## The weekly check

Read the pick the same way. With no pick, or a system marked Not yet, say nothing and end the session.
`

export const ACCOUNTING_SYSTEMS_SKILL: SkillData = {
	id: ACCOUNTING_SYSTEMS_SKILL_ID,
	workspaceId: '00000000-0000-0000-0000-000000000000',
	name: 'accounting-systems',
	description:
		'Which accounting systems the owner can pick, how far each one connects, and what to do with the pick.',
	content,
	isValid: true,
	attachedActorIds: [ACCOUNTING_LOOP_ACTOR_BOOKKEEPER],
}
