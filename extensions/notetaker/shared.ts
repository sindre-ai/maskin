/** Module ID — shared between server and web definitions to ensure consistency */
export const MODULE_ID = 'notetaker' as const
export const MODULE_NAME = 'Notetaker'

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
