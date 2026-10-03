import type { FieldDefinition, ModuleDefaultSettings } from '@maskin/module-sdk'

/** Module ID — shared between server and web definitions to ensure consistency */
export const MODULE_ID = 'knowledge' as const
export const MODULE_NAME = 'Knowledge'

export const KNOWLEDGE_STATUSES = ['draft', 'validated', 'deprecated']
export const KNOWLEDGE_RELATIONSHIP_TYPES = ['supersedes', 'contradicts', 'about']
export const KNOWLEDGE_DISPLAY_NAME = 'Knowledge'

export const KNOWLEDGE_DOC_TYPES = [
	'topic_page',
	'playbook',
	'operational',
	'profile',
	'changelog',
	'reference',
	'note',
]

export const KNOWLEDGE_FIELDS: FieldDefinition[] = [
	{ name: 'doc_type', type: 'enum', values: KNOWLEDGE_DOC_TYPES },
	{ name: 'provenance', type: 'text' },
	{ name: 'last_validated_at', type: 'date' },
	{ name: 'review_by', type: 'date' },
	{ name: 'summary', type: 'text', required: true },
	{
		name: 'confidence',
		type: 'enum',
		values: ['low', 'medium', 'high'],
	},
	{ name: 'tags', type: 'text' },
	// Only knowledge flipped to true is exported to the Telnyx voice assistant's knowledge base.
	// Absent reads as false. Review step, not self-service: see providers/telnyx/knowledge-exporter.ts.
	{ name: 'customer_facing', type: 'boolean' },
]

export const KNOWLEDGE_DEFAULT_SETTINGS: ModuleDefaultSettings = {
	display_names: {
		knowledge: KNOWLEDGE_DISPLAY_NAME,
	},
	statuses: {
		knowledge: KNOWLEDGE_STATUSES,
	},
	field_definitions: {
		knowledge: KNOWLEDGE_FIELDS,
	},
	relationship_types: KNOWLEDGE_RELATIONSHIP_TYPES,
}
