// Canonical source-item IDs and metadata for the Meeting Loop marketplace
// loop. The bundle is a single agent, the Meeting Manager. Trigger and skill
// IDs are not listed as constants: they are derived per actor via
// `triggerIdsForActor` / `skillIdsForActor` in
// apps/dev/src/lib/marketplace-loops/loop-data.

export const MEETING_LOOP_ACTOR_MEETING_MANAGER = '8941afb0-cab2-553c-8370-2e45ada99d0e'

export const MEETING_LOOP_SLUG = 'meeting-loop'
export const MEETING_LOOP_NAME = 'Meeting insights'
export const MEETING_LOOP_VERSION = '1.2.0'
export const MEETING_LOOP_USE_CASE = 'Operations'
export const MEETING_LOOP_DESCRIPTION =
	'Turns every meeting into work that gets done. When a meeting ends, the Meeting Manager reads the transcript, writes up what happened by meeting type, links the people and companies who were there, files tasks, decisions and insights, and hands each task to the right person or agent. It then follows up until every promise, yours and theirs, is done and checked. It drafts an agenda for new internal meetings, catches meetings that were never processed, and checks every day that nothing is stuck. Works with whichever meeting tool you connect, such as Google Meet or Microsoft Teams, or with a notetaker tool or a calendar for tools like Zoom.'
