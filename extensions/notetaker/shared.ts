import type { FieldDefinition, ModuleDefaultSettings } from '@maskin/module-sdk'

/** Module ID — shared between server and web definitions to ensure consistency */
export const MODULE_ID = 'notetaker' as const
export const MODULE_NAME = 'Notetaker'

export const MEETING_DISPLAY_NAME = 'Meeting'

export const MEETING_STATUSES = [
	'scheduled',
	'in_progress',
	'recording',
	'transcribing',
	'done',
	'failed',
	'cancelled',
] as const

export const MEETING_RELATIONSHIP_TYPES = ['produced', 'about', 'attended_by'] as const

export const MEETING_FIELDS: FieldDefinition[] = [
	{ name: 'meetingUrl', type: 'text' },
	{ name: 'startTime', type: 'date' },
	{ name: 'endTime', type: 'date' },
	{ name: 'language', type: 'text' },
	{ name: 'audioUrl', type: 'text' },
	{ name: 'transcriptUrl', type: 'text' },
	{ name: 'calendarProvider', type: 'enum', values: ['google'] },
	{ name: 'calendarEventId', type: 'text' },
	{ name: 'skjaldJoin', type: 'boolean' },
	{ name: 'botName', type: 'text' },
	{ name: 'autoJoin', type: 'boolean' },
]

export const NOTETAKER_DEFAULT_SETTINGS: ModuleDefaultSettings = {
	display_names: {
		meeting: MEETING_DISPLAY_NAME,
	},
	statuses: {
		meeting: [...MEETING_STATUSES],
	},
	field_definitions: {
		meeting: MEETING_FIELDS,
	},
	relationship_types: [...MEETING_RELATIONSHIP_TYPES],
}
