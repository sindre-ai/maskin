// Canonical source-item IDs and metadata for the Presentation Designer marketplace listing.
// The listing is one agent, not a flow: it ships the Presentation Designer and seven skills,
// with no triggers, no views and no flow page. Skill IDs are not listed as constants: they are
// derived per actor via `skillIdsForActor` in apps/dev/src/lib/marketplace-loops/loop-data.

export const PRESENTATION_DESIGNER_ACTOR = '47c60e97-99ba-456a-9daa-602f4628006c'

export const PRESENTATION_DESIGNER_LOOP_SLUG = 'presentation-designer'
export const PRESENTATION_DESIGNER_LOOP_NAME = 'Presentation Designer'
export const PRESENTATION_DESIGNER_LOOP_VERSION = '1.0.0'
export const PRESENTATION_DESIGNER_LOOP_USE_CASE = 'Marketing'
export const PRESENTATION_DESIGNER_LOOP_DESCRIPTION =
	'Turns a brief into a focused deck: one HTML file with landscape and portrait layouts, a narrative check before the design, and a visual check on its own computer before delivery. At install it looks for your design style in knowledge pages, files and brand notes, uses what it finds, and asks for a link, a file or a few words if it finds none. It builds decks and the slide visuals inside them, asks whether the deck is speaker-led or reading-first, and marks each screen size it actually checked, or says plainly that it was not visually checked.'
