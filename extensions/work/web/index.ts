import type { ModuleWebDefinition } from '@ai-native/module-sdk'
import { MODULE_ID, MODULE_NAME } from '../shared.js'

const workWebExtension: ModuleWebDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	navItems: [],
	objectTypeTabs: [
		{ label: 'Insights', value: 'insight' },
		{ label: 'Bets', value: 'bet' },
		{ label: 'Tasks', value: 'task' },
	],
	defaultSettings: {
		display_names: {
			insight: 'Insight',
			bet: 'Bet',
			task: 'Task',
		},
		statuses: {
			insight: ['new', 'processing', 'clustered', 'discarded'],
			bet: ['signal', 'proposed', 'active', 'completed', 'succeeded', 'failed', 'paused'],
			task: ['todo', 'in_progress', 'done', 'blocked'],
		},
	},
}

export default workWebExtension
