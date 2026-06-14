import type { ModuleDefinition } from '@maskin/module-sdk'
import {
	MEETING_DISPLAY_NAME,
	MEETING_FIELDS,
	MEETING_RELATIONSHIP_TYPES,
	MEETING_STATUSES,
	MODULE_ID,
	MODULE_NAME,
	NOTETAKER_DEFAULT_SETTINGS,
} from '../shared.js'

const notetakerExtension: ModuleDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	version: '0.1.0',
	objectTypes: [
		{
			type: 'meeting',
			label: MEETING_DISPLAY_NAME,
			icon: 'video',
			defaultStatuses: [...MEETING_STATUSES],
			defaultFields: MEETING_FIELDS,
			defaultRelationshipTypes: [...MEETING_RELATIONSHIP_TYPES],
		},
	],
	defaultSettings: NOTETAKER_DEFAULT_SETTINGS,
}

export default notetakerExtension
