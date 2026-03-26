export interface FieldDefinition {
	name: string
	type: 'text' | 'number' | 'date' | 'enum' | 'boolean'
	required?: boolean
	values?: string[]
}

export interface ExtensionTemplate {
	id: string
	name: string
	description: string
	settings: {
		display_names: Record<string, string>
		statuses: Record<string, string[]>
		field_definitions: Record<string, FieldDefinition[]>
		relationship_types?: string[]
	}
}

export const templates: Record<string, ExtensionTemplate> = {
	crm: {
		id: 'crm',
		name: 'CRM',
		description:
			'Customer relationship management — track leads, customers, and deals through your sales pipeline.',
		settings: {
			display_names: {
				lead: 'Lead',
				customer: 'Customer',
				deal: 'Deal',
			},
			statuses: {
				lead: ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'],
				customer: ['active', 'churned', 'archived'],
				deal: ['discovery', 'negotiation', 'closed_won', 'closed_lost'],
			},
			field_definitions: {
				lead: [
					{ name: 'company', type: 'text' },
					{ name: 'value', type: 'number' },
					{ name: 'source', type: 'enum', values: ['inbound', 'outbound', 'referral'] },
				],
				customer: [
					{ name: 'tier', type: 'enum', values: ['free', 'starter', 'pro', 'enterprise'] },
					{ name: 'arr', type: 'number' },
				],
				deal: [
					{ name: 'amount', type: 'number', required: true },
					{ name: 'close_date', type: 'date' },
				],
			},
			relationship_types: ['converts_to', 'owns'],
		},
	},
	project_management: {
		id: 'project_management',
		name: 'Project Management',
		description:
			'Agile project management — organize work into epics, stories, and bugs with priority tracking.',
		settings: {
			display_names: {
				epic: 'Epic',
				story: 'Story',
				bug: 'Bug',
			},
			statuses: {
				epic: ['backlog', 'in_progress', 'done'],
				story: ['backlog', 'ready', 'in_progress', 'review', 'done'],
				bug: ['open', 'triaging', 'fixing', 'testing', 'resolved', 'wont_fix'],
			},
			field_definitions: {
				story: [
					{ name: 'points', type: 'number' },
					{ name: 'priority', type: 'enum', values: ['low', 'medium', 'high', 'critical'] },
				],
				bug: [
					{
						name: 'severity',
						type: 'enum',
						required: true,
						values: ['p0', 'p1', 'p2', 'p3'],
					},
					{ name: 'reproducible', type: 'boolean' },
				],
			},
			relationship_types: ['belongs_to', 'depends_on'],
		},
	},
	content_pipeline: {
		id: 'content_pipeline',
		name: 'Content Pipeline',
		description:
			'Content creation workflow — manage ideas, articles, and campaigns from ideation to publication.',
		settings: {
			display_names: {
				idea: 'Idea',
				article: 'Article',
				campaign: 'Campaign',
			},
			statuses: {
				idea: ['draft', 'approved', 'rejected'],
				article: ['outline', 'writing', 'review', 'published', 'archived'],
				campaign: ['planning', 'active', 'paused', 'completed'],
			},
			field_definitions: {
				article: [
					{ name: 'word_count', type: 'number' },
					{ name: 'author', type: 'text' },
					{ name: 'publish_date', type: 'date' },
				],
				campaign: [
					{
						name: 'channel',
						type: 'enum',
						values: ['blog', 'social', 'email', 'ads'],
					},
					{ name: 'budget', type: 'number' },
				],
			},
			relationship_types: ['part_of', 'promotes'],
		},
	},
	customer_success: {
		id: 'customer_success',
		name: 'Customer Success',
		description:
			'Customer support and feedback — track tickets, feedback, and feature requests to improve your product.',
		settings: {
			display_names: {
				ticket: 'Ticket',
				feedback: 'Feedback',
				feature_request: 'Feature Request',
			},
			statuses: {
				ticket: ['open', 'in_progress', 'waiting', 'resolved', 'closed'],
				feedback: ['new', 'reviewed', 'actionable', 'archived'],
				feature_request: ['submitted', 'under_review', 'planned', 'building', 'shipped', 'declined'],
			},
			field_definitions: {
				ticket: [
					{
						name: 'priority',
						type: 'enum',
						required: true,
						values: ['low', 'medium', 'high', 'urgent'],
					},
					{ name: 'category', type: 'enum', values: ['bug', 'question', 'billing', 'other'] },
				],
				feedback: [
					{ name: 'sentiment', type: 'enum', values: ['positive', 'neutral', 'negative'] },
					{ name: 'source', type: 'text' },
				],
				feature_request: [
					{ name: 'votes', type: 'number' },
					{ name: 'effort', type: 'enum', values: ['small', 'medium', 'large', 'xl'] },
				],
			},
			relationship_types: ['requested_by', 'resolves'],
		},
	},
}
