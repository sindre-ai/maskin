// Canonical source-item IDs and metadata for the Signal Intake marketplace loop (install slug
// signal-intake-flow). The one actor is the Signal Listener. Trigger and skill IDs are not listed
// as constants: they are derived per actor via `triggerIdsForActor` / `skillIdsForActor` in
// apps/dev/src/lib/marketplace-loops/loop-data.

export const SIGNAL_INTAKE_ACTOR_LISTENER = '24a7ebfe-6054-4c73-8ba7-53e34b5881d9'

export const SIGNAL_INTAKE_LOOP_SLUG = 'signal-intake-flow'
export const SIGNAL_INTAKE_LOOP_NAME = 'Signal Intake Flow'
export const SIGNAL_INTAKE_LOOP_VERSION = '1.0.0'
export const SIGNAL_INTAKE_LOOP_USE_CASE = 'Discovery'
export const SIGNAL_INTAKE_LOOP_DESCRIPTION =
	'Listens outside your company so you do not rely on a forwarded thread. A listening agent reads public discussions about topics you name, the public posts of people you choose to watch, and the open-source projects and releases in your area. It files one short, sourced note per notable idea and sends them to your discovery process. It never posts or engages. It runs on a schedule with no end state.'
