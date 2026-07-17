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
			bet: ['signal', 'qualified', 'define', 'active', 'live', 'succeeded', 'failed', 'paused'],
			task: ['todo', 'in_progress', 'in_review', 'validated', 'done', 'discarded'],
			loop: ['holding', 'at-risk', 'breached'],
		},
		field_definitions: {
			loop: [
				{ name: 'floor', type: 'text' },
				{ name: 'cadence', type: 'text' },
				{ name: 'source_bet_id', type: 'text' },
				{ name: 'last_breach_at', type: 'date' },
			],
		},
	},
}

export default workWebExtension
