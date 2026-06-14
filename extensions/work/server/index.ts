import type { ModuleDefinition } from '@maskin/module-sdk'
import { MODULE_ID, MODULE_NAME } from '../shared.js'

const workExtension: ModuleDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	version: '0.1.0',
	objectTypes: [
		{
			type: 'insight',
			label: 'Insight',
			icon: 'lightbulb',
			defaultStatuses: ['new', 'processing', 'clustered', 'scored', 'parked', 'discarded'],
		},
		{
			type: 'bet',
			label: 'Bet',
			icon: 'target',
			defaultStatuses: [
				'signal',
				'qualified',
				'proposed',
				'active',
				'completed',
				'succeeded',
				'failed',
				'paused',
			],
		},
		{
			type: 'task',
			label: 'Task',
			icon: 'check-square',
			defaultStatuses: ['todo', 'in_progress', 'done', 'blocked'],
		},
	],
	defaultSettings: {
		display_names: {
			insight: 'Insight',
			bet: 'Bet',
			task: 'Task',
		},
		statuses: {
			insight: ['new', 'processing', 'clustered', 'scored', 'parked', 'discarded'],
			bet: [
				'signal',
				'qualified',
				'proposed',
				'active',
				'completed',
				'succeeded',
				'failed',
				'paused',
			],
			task: ['todo', 'in_progress', 'done', 'blocked'],
		},
	},
}

export default workExtension
