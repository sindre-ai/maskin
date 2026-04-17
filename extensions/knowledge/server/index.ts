import type { ModuleDefinition } from '@maskin/module-sdk'
import { MODULE_ID, MODULE_NAME } from '../shared.js'

const knowledgeExtension: ModuleDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	version: '0.1.0',
	objectTypes: [
		{
			type: 'knowledge',
			label: 'Article',
			icon: 'book-open',
			defaultStatuses: ['draft', 'validated', 'deprecated'],
			defaultFields: [
				{ name: 'summary', type: 'text', required: true },
				{
					name: 'confidence',
					type: 'enum',
					values: ['low', 'medium', 'high'],
				},
				{ name: 'tags', type: 'text' },
				{ name: 'last_validated_at', type: 'date' },
			],
			defaultRelationshipTypes: ['supersedes', 'contradicts', 'about'],
		},
	],
	defaultSettings: {
		display_names: {
			knowledge: 'Article',
		},
		statuses: {
			knowledge: ['draft', 'validated', 'deprecated'],
		},
		field_definitions: {
			knowledge: [
				{ name: 'summary', type: 'text', required: true },
				{
					name: 'confidence',
					type: 'enum',
					values: ['low', 'medium', 'high'],
				},
				{ name: 'tags', type: 'text' },
				{ name: 'last_validated_at', type: 'date' },
			],
		},
		relationship_types: ['supersedes', 'contradicts', 'about'],
	},
}

export default knowledgeExtension
