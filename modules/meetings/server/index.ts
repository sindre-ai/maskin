import type { ModuleDefinition } from '@ai-native/module-sdk'
import { MEETINGS_OBJECT_TYPES } from '../shared/index.js'
import { meetingRoutes } from './routes.js'

const meetingsModule: ModuleDefinition = {
	id: 'meetings',
	name: 'Meetings',
	version: '0.1.0',
	objectTypes: MEETINGS_OBJECT_TYPES.map((t) => ({
		...t,
		defaultStatuses: [...t.defaultStatuses],
	})),
	routes: (env) => meetingRoutes(env),
	defaultSettings: {
		display_names: Object.fromEntries(MEETINGS_OBJECT_TYPES.map((t) => [t.type, t.label])),
		statuses: Object.fromEntries(
			MEETINGS_OBJECT_TYPES.map((t) => [t.type, [...t.defaultStatuses]]),
		),
	},
}

export default meetingsModule
