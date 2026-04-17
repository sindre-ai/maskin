import type { ModuleDefinition } from '@maskin/module-sdk'
import { MEETING_RELATIONSHIP_TYPES, MEETING_STATUSES, MODULE_ID, MODULE_NAME } from '../shared.js'

const notetakerExtension: ModuleDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	version: '0.1.0',
	objectTypes: [
		{
			type: 'meeting',
			label: 'Meeting',
			icon: 'video',
			defaultStatuses: [...MEETING_STATUSES],
			defaultRelationshipTypes: [...MEETING_RELATIONSHIP_TYPES],
		},
	],
	defaultSettings: {
		display_names: {
			meeting: 'Meeting',
		},
		statuses: {
			meeting: [...MEETING_STATUSES],
		},
	},
}

export default notetakerExtension
