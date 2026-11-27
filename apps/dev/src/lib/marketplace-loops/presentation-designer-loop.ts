// Shared constants for the Presentation Designer marketplace listing.
//
// The listing is a single agent, not a flow: it ships the Presentation Designer and the seven
// skills it loads, with no triggers, no views and no flow page. Install creates the agent and its
// skills, then opens the agent's chat with a first look for the person's design style (see
// loop-settings.ts agentOnly and firstLook, and services/agent-only-install.ts).
//
// The prompt and skills in data/presentation-designer-*.json are written to be
// workspace-neutral: they carry no company, person, product, date or id, and they work with
// whatever design style the installer already has or gives the agent.
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	PRESENTATION_DESIGNER_ACTOR,
	PRESENTATION_DESIGNER_LOOP_DESCRIPTION,
	PRESENTATION_DESIGNER_LOOP_NAME,
	PRESENTATION_DESIGNER_LOOP_SLUG,
	PRESENTATION_DESIGNER_LOOP_USE_CASE,
	PRESENTATION_DESIGNER_LOOP_VERSION,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'
import type { LoopSettings } from './loop-settings'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './loop-snapshot'

// No flow page and no flow setup chat: the install puts the agent in the workspace and opens its
// direct message. firstLook tells the hello scan where to look for a design style and how to ask
// when none exists. It names knowledge pages and files because the scan does not search those by
// itself.
const PRESENTATION_DESIGNER_SETTINGS: LoopSettings = {
	agentOnly: true,
	firstLook:
		'Search knowledge pages, files and brand notes for a design style: a page titled "Design style", a style guide, colour tokens, a typeface or a logo. If you find one, use it and say what you found. If you find none, ask for a link, a file or a few words about colours, type and feel. When the person gives you a style, save it as a knowledge page titled "Design style" so the next deck finds it.',
}

export const PRESENTATION_DESIGNER_LOOP = {
	slug: PRESENTATION_DESIGNER_LOOP_SLUG,
	name: PRESENTATION_DESIGNER_LOOP_NAME,
	version: PRESENTATION_DESIGNER_LOOP_VERSION,
	useCase: PRESENTATION_DESIGNER_LOOP_USE_CASE,
	settings: PRESENTATION_DESIGNER_SETTINGS,
	description: PRESENTATION_DESIGNER_LOOP_DESCRIPTION,
} as const

export const PRESENTATION_DESIGNER_ACTOR_IDS = [PRESENTATION_DESIGNER_ACTOR] as const

// A listing with no triggers still derives its trigger ids the same way as every other bundle, so
// a trigger added later is picked up without a second list to keep in step.
export const PRESENTATION_DESIGNER_TRIGGER_IDS: readonly string[] =
	PRESENTATION_DESIGNER_ACTOR_IDS.flatMap(triggerIdsForActor)

export const PRESENTATION_DESIGNER_SKILL_IDS: readonly string[] = [
	...new Set(PRESENTATION_DESIGNER_ACTOR_IDS.flatMap(skillIdsForActor)),
]
