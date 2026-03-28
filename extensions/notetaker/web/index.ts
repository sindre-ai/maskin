import type { ModuleWebDefinition } from '@ai-native/module-sdk'
import { MODULE_ID, MODULE_NAME } from '../shared.js'

const notetakerWebExtension: ModuleWebDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	navItems: [],
	objectTypeTabs: [{ label: 'Meetings', value: 'meeting' }],
	defaultSettings: {
		display_names: {
			meeting: 'Meeting',
		},
		statuses: {
			meeting: ['scheduled', 'recording', 'transcribing', 'completed', 'failed'],
		},
	},
}

export default notetakerWebExtension
