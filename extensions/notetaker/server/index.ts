import type { ModuleDefinition, ModuleEnv } from '@ai-native/module-sdk'
import { OpenAPIHono } from '@hono/zod-openapi'
import { MODULE_ID, MODULE_NAME } from '../shared.js'
import { createBotRoutes } from './routes/bot.js'
import { createFileRoutes } from './routes/files.js'
import healthRoutes from './routes/health.js'
import { createProcessRoutes } from './routes/process.js'
import { createUploadRoutes } from './routes/upload.js'

function createRoutes(env: ModuleEnv) {
	const app = new OpenAPIHono()
	app.route('/', healthRoutes)
	app.route('/', createUploadRoutes(env))
	app.route('/', createProcessRoutes(env))
	app.route('/', createBotRoutes(env))
	app.route('/', createFileRoutes(env))
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
		field_definitions: {
			meeting: [
				{ name: 'send_meeting_bot', type: 'boolean' },
				{ name: 'meeting_url', type: 'text' },
				{ name: 'start', type: 'date' },
				{ name: 'end', type: 'date' },
				{ name: 'language', type: 'text' },
				{ name: 'audio_url', type: 'text' },
				{ name: 'transcript_url', type: 'text' },
				{ name: 'segments_url', type: 'text' },
				{ name: 'duration_seconds', type: 'number' },
			],
		},
	},
}

export default notetakerExtension
