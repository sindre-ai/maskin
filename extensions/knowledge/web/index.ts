import type { ModuleWebDefinition } from '@maskin/module-sdk'
import { MODULE_ID, MODULE_NAME } from '../shared.js'

const knowledgeWebExtension: ModuleWebDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	navItems: [
		{
			label: 'Knowledge',
			path: 'knowledge',
			icon: 'book-open',
		},
	],
	objectTypeTabs: [{ label: 'Knowledge', value: 'knowledge' }],
	defaultSettings: {
		display_names: {
			knowledge: 'Knowledge',
		},
		statuses: {
			knowledge: ['draft', 'review', 'confirmed', 'superseded', 'deprecated'],
		},
		field_definitions: {
			knowledge: [
				{
					name: 'source',
					type: 'enum',
					values: ['human', 'ai', 'hybrid'],
				},
				{
					name: 'confidence',
					type: 'enum',
					values: ['high', 'medium', 'low', 'unverified'],
				},
				{
					name: 'scope',
					type: 'enum',
					values: ['personal', 'team', 'canonical'],
				},
				{
					name: 'domain',
					type: 'text',
				},
				{
					name: 'last_confirmed',
					type: 'date',
				},
			],
		},
		relationship_types: ['derived_from', 'extends', 'contradicts', 'supports', 'supersedes'],
	},
}

export default knowledgeWebExtension
