import type { FieldDefinition, ModuleDefaultSettings } from '@maskin/module-sdk'

/** Module ID — shared between server and web definitions to ensure consistency */
export const MODULE_ID = 'knowledge' as const
export const MODULE_NAME = 'Knowledge'

export const KNOWLEDGE_STATUSES = ['draft', 'validated', 'deprecated']
export const KNOWLEDGE_RELATIONSHIP_TYPES = ['supersedes', 'contradicts', 'about']
export const KNOWLEDGE_DISPLAY_NAME = 'Article'

export const KNOWLEDGE_FIELDS: FieldDefinition[] = [
	{ name: 'summary', type: 'text', required: true },
	{
		name: 'confidence',
		type: 'enum',
		values: ['low', 'medium', 'high'],
	},
	{ name: 'tags', type: 'text' },
	{ name: 'last_validated_at', type: 'date' },
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
