import type { ObjectTypeDefinition } from '../schemas/workspaces'

const insightType: ObjectTypeDefinition = {
	slug: 'insight',
	display_name: 'Insight',
	icon: 'lightbulb',
	color: 'amber',
	statuses: ['new', 'processing', 'clustered', 'discarded'],
	default_status: 'new',
	field_definitions: [],
	source: 'core',
}

const betType: ObjectTypeDefinition = {
	slug: 'bet',
	display_name: 'Bet',
	icon: 'target',
	color: 'indigo',
	statuses: ['signal', 'proposed', 'active', 'completed', 'succeeded', 'failed', 'paused'],
	default_status: 'signal',
	field_definitions: [],
	source: 'core',
}

const taskType: ObjectTypeDefinition = {
	slug: 'task',
	display_name: 'Task',
	icon: 'check-square',
	color: 'emerald',
	statuses: ['todo', 'in_progress', 'done', 'blocked'],
	default_status: 'todo',
	field_definitions: [],
	source: 'core',
}

export interface WorkspaceTemplate {
	id: string
	name: string
	description: string
	object_types: ObjectTypeDefinition[]
	relationship_types: string[]
}

export const workspaceTemplates: Record<string, WorkspaceTemplate> = {
	product: {
		id: 'product',
		name: 'Product',
		description: 'Track insights, bets, and tasks for product development',
		object_types: [insightType, betType, taskType],
		relationship_types: ['informs', 'breaks_into', 'blocks', 'relates_to', 'duplicates'],
	},
	crm: {
		id: 'crm',
		name: 'CRM',
		description: 'Manage people, companies, and deals',
		object_types: [
			{
				slug: 'person',
				display_name: 'Person',
				icon: 'user',
				color: 'blue',
				statuses: ['lead', 'prospect', 'customer', 'churned'],
				default_status: 'lead',
				field_definitions: [
					{ name: 'email', type: 'text', required: false },
					{ name: 'phone', type: 'text', required: false },
					{ name: 'job_title', type: 'text', required: false },
				],
				source: 'custom',
			},
			{
				slug: 'company',
				display_name: 'Company',
				icon: 'building',
				color: 'violet',
				statuses: ['prospect', 'customer', 'partner', 'churned'],
				default_status: 'prospect',
				field_definitions: [
					{ name: 'website', type: 'text', required: false },
					{ name: 'industry', type: 'text', required: false },
					{ name: 'size', type: 'enum', required: false, values: ['1-10', '11-50', '51-200', '201-1000', '1000+'] },
				],
				source: 'custom',
			},
			{
				slug: 'deal',
				display_name: 'Deal',
				icon: 'handshake',
				color: 'green',
				statuses: ['qualification', 'proposal', 'negotiation', 'won', 'lost'],
				default_status: 'qualification',
				field_definitions: [
					{ name: 'value', type: 'number', required: false },
					{ name: 'close_date', type: 'date', required: false },
				],
				source: 'custom',
			},
		],
		relationship_types: ['works_at', 'owns', 'involves', 'relates_to'],
	},
	blank: {
		id: 'blank',
		name: 'Blank',
		description: 'Start from scratch with no pre-defined types',
		object_types: [],
		relationship_types: ['relates_to'],
	},
}
