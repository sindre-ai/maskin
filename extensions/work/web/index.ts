import type { ModuleWebDefinition } from '@maskin/module-sdk'
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
			loop: 'Loop',
		},
		statuses: {
			insight: ['new', 'processing', 'clustered', 'scored', 'parked', 'discarded'],
			bet: ['signal', 'define', 'active', 'live', 'succeeded', 'failed', 'paused'],
			task: ['todo', 'in_progress', 'in_review', 'validated', 'done', 'discarded'],
			loop: ['draft', 'paused', 'learning', 'supervised', 'fully_autonomous'],
		},
		field_definitions: {
			loop: [
				{ name: 'entry_condition', type: 'text' },
				{ name: 'close_condition', type: 'text' },
				{ name: 'installed_from_marketplace_loop_id', type: 'text' },
			],
		},
	},
}

export default workWebExtension
