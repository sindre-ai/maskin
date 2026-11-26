// Shared constants for the Customer Voice Flow marketplace bundle.
//
// The bundle contains one agent, the Customer Voice Analyst, plus its two triggers (a
// weekday sweep and an owner heartbeat), three skills and one custom view (Results).
// The snapshot data is written to be workspace-neutral and lives in
// data/customer-voice-*.json. Every source the sweep reads (support inbox, customer chat
// channels, a mailbox) is optional, so the flow installs and runs with none connected.
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	CUSTOMER_VOICE_ACTOR_ANALYST,
	CUSTOMER_VOICE_LOOP_DESCRIPTION,
	CUSTOMER_VOICE_LOOP_NAME,
	CUSTOMER_VOICE_LOOP_SLUG,
	CUSTOMER_VOICE_LOOP_USE_CASE,
	CUSTOMER_VOICE_LOOP_VERSION,
} from '@maskin/shared'
import customerVoiceViewsData from './data/customer-voice-views.json'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'
import type { LoopSettings } from './loop-settings'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './loop-snapshot'

// What the flow page shows beside the tab. Only one target ships: the owner heartbeat updates
// the row with this exact label from its own count. The live flow's second target (feedback
// insights per month) is a number the publisher chose for its own volume, so it stays out.
const CUSTOMER_VOICE_SETTINGS: LoopSettings = {
	entryCondition:
		'A customer or VIP writes to you by email or in a one-to-one customer chat channel with a request, complaint, question or praise.',
	closeCondition:
		'The message is filed once as an insight with its source link, or deliberately skipped as noise.',
	tags: ['Context'],
	targets: [
		{
			label: 'Weekly sweeps',
			source:
				'Weekdays. The owner heartbeat counts the sweeps that ran this week. Not counted yet.',
			actual: 0,
			target: 5,
			pace_policy: 'window',
		},
	],
}

export const CUSTOMER_VOICE_LOOP = {
	slug: CUSTOMER_VOICE_LOOP_SLUG,
	name: CUSTOMER_VOICE_LOOP_NAME,
	version: CUSTOMER_VOICE_LOOP_VERSION,
	useCase: CUSTOMER_VOICE_LOOP_USE_CASE,
	settings: CUSTOMER_VOICE_SETTINGS,
	description: CUSTOMER_VOICE_LOOP_DESCRIPTION,
} as const

export const CUSTOMER_VOICE_ACTOR_IDS = [CUSTOMER_VOICE_ACTOR_ANALYST] as const

export const CUSTOMER_VOICE_TRIGGER_IDS: readonly string[] =
	CUSTOMER_VOICE_ACTOR_IDS.flatMap(triggerIdsForActor)

export const CUSTOMER_VOICE_SKILL_IDS: readonly string[] = [
	...new Set(CUSTOMER_VOICE_ACTOR_IDS.flatMap(skillIdsForActor)),
]

// The flow page's tab. Results ships as a starter page that reads live counts and shows its
// quiet state in an empty workspace. See data/customer-voice-views.json.
export const CUSTOMER_VOICE_VIEW_IDS: readonly string[] = Object.values(customerVoiceViewsData)
	.sort((a, b) => a.position - b.position)
	.map((view) => view.id)
