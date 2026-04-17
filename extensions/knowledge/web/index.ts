import type { ModuleWebDefinition } from '@maskin/module-sdk'
import { MODULE_ID, MODULE_NAME } from '../shared.js'

const knowledgeWebExtension: ModuleWebDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	navItems: [],
	objectTypeTabs: [{ label: 'Knowledge', value: 'knowledge' }],
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

export default knowledgeWebExtension
