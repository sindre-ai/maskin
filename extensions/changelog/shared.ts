import type { FieldDefinition, ModuleDefaultSettings } from '@maskin/module-sdk'

/** Module ID — shared between server and web definitions to ensure consistency */
export const MODULE_ID = 'changelog' as const
export const MODULE_NAME = 'Changelog'

export const CHANGELOG_ENTRY_TYPE = 'changelog_entry' as const
export const CHANGELOG_ENTRY_DISPLAY_NAME = 'Changelog entry'
export const CHANGELOG_ENTRY_STATUSES = ['draft', 'approved', 'published']

/** Tag values rendered as badges on the public Chronicle page. */
export const CHANGELOG_ENTRY_TAGS = ['New', 'Improved', 'Fixed']

export const CHANGELOG_ENTRY_FIELDS: FieldDefinition[] = [
	{ name: 'tag', type: 'enum', values: CHANGELOG_ENTRY_TAGS, required: true },
	{ name: 'source_bet_id', type: 'text', required: true },
	{ name: 'hero_image_url', type: 'text' },
	{ name: 'quality_flag', type: 'boolean' },
	// Set explicitly by whoever/whatever flips status to `published` (the
	// Changelog Publisher, once it exists). The public feed (public-changelog.ts)
	// falls back to the row's updated_at when this is absent, but prefers this
	// field so a later content edit doesn't change an entry's public publish date.
	{ name: 'published_at', type: 'date' },
]

/** Bet-level marker the Bet Strategist sets at `define` to opt a bet into the
 * changelog pipeline. Declared here so settings reflect the field when both
 * `work` and `changelog` modules are enabled. */
export const BET_CHANGELOG_FIELDS: FieldDefinition[] = [
	{ name: 'changelog_eligible', type: 'boolean' },
]

export const CHANGELOG_DEFAULT_SETTINGS: ModuleDefaultSettings = {
	display_names: {
		[CHANGELOG_ENTRY_TYPE]: CHANGELOG_ENTRY_DISPLAY_NAME,
	},
	statuses: {
		[CHANGELOG_ENTRY_TYPE]: CHANGELOG_ENTRY_STATUSES,
	},
	field_definitions: {
		[CHANGELOG_ENTRY_TYPE]: CHANGELOG_ENTRY_FIELDS,
		bet: BET_CHANGELOG_FIELDS,
	},
}
