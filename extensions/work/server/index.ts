import type { FieldDefinition, ModuleDefinition } from '@maskin/module-sdk'
import { MODULE_ID, MODULE_NAME } from '../shared.js'

const LOOP_STATUSES = ['holding', 'at-risk', 'breached']
const LOOP_FIELDS: FieldDefinition[] = [
	{ name: 'floor', type: 'text' },
	{ name: 'cadence', type: 'text' },
	{ name: 'source_bet_id', type: 'text' },
	{ name: 'last_breach_at', type: 'date' },
]

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
				'define',
				'active',
				'live',
				'succeeded',
				'failed',
				'paused',
			],
		},
		{
			type: 'task',
			label: 'Task',
			icon: 'check-square',
			defaultStatuses: ['todo', 'in_progress', 'in_review', 'validated', 'done', 'discarded'],
		},
		{
			type: 'loop',
			label: 'Loop',
			icon: 'repeat',
			defaultStatuses: LOOP_STATUSES,
			defaultFields: LOOP_FIELDS,
		},
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
			loop: LOOP_STATUSES,
		},
		field_definitions: {
			loop: LOOP_FIELDS,
		},
	},
}

export default workExtension
