import type { ModuleDefinition } from '@ai-native/module-sdk'
import { WORK_OBJECT_TYPES } from '../shared/index.js'

const workModule: ModuleDefinition = {
	id: 'work',
	name: 'Work',
	version: '0.1.0',
	objectTypes: WORK_OBJECT_TYPES.map((t) => ({ ...t, defaultStatuses: [...t.defaultStatuses] })),
	defaultSettings: {
		display_names: Object.fromEntries(WORK_OBJECT_TYPES.map((t) => [t.type, t.label])),
		statuses: Object.fromEntries(WORK_OBJECT_TYPES.map((t) => [t.type, [...t.defaultStatuses]])),
	},
}

export default workModule
