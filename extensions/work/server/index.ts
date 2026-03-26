import type { ModuleDefinition } from '@ai-native/module-sdk'

const workExtension: ModuleDefinition = {
	id: 'work',
	name: 'Work',
	version: '0.1.0',
	objectTypes: [
		{
			type: 'insight',
			label: 'Insight',
			icon: 'lightbulb',
			defaultStatuses: ['new', 'processing', 'clustered', 'discarded'],
		},
		{
			type: 'bet',
			label: 'Bet',
			icon: 'target',
			defaultStatuses: [
				'signal',
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
			insight: ['new', 'processing', 'clustered', 'discarded'],
			bet: ['signal', 'proposed', 'active', 'completed', 'succeeded', 'failed', 'paused'],
			task: ['todo', 'in_progress', 'done', 'blocked'],
		},
	},
}

export default workExtension
