import type { ModuleDefinition, ModuleEnv } from '@ai-native/module-sdk'
import { OpenAPIHono } from '@hono/zod-openapi'
import { MODULE_ID, MODULE_NAME } from '../shared.js'

function createRoutes(_env: ModuleEnv) {
	const app = new OpenAPIHono()
	return app
}

const notetakerExtension: ModuleDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	version: '0.1.0',
	objectTypes: [
		{
			type: 'meeting',
			label: 'Meeting',
			icon: 'video',
			defaultStatuses: ['scheduled', 'recording', 'transcribing', 'completed', 'failed'],
		},
	],
	routes: createRoutes,
	defaultSettings: {
		display_names: {
			meeting: 'Meeting',
		},
		statuses: {
			meeting: ['scheduled', 'recording', 'transcribing', 'completed', 'failed'],
		},
	},
}

export default notetakerExtension
