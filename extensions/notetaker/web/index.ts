import type { ModuleWebDefinition } from '@maskin/module-sdk'
import { MEETING_STATUSES, MODULE_ID, MODULE_NAME } from '../shared.js'

const notetakerWebExtension: ModuleWebDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	navItems: [],
	objectTypeTabs: [
		{ label: 'Meetings', value: 'meeting' },
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

export default notetakerWebExtension
