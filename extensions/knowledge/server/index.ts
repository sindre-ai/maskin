import type { ModuleDefinition } from '@maskin/module-sdk'
import { MODULE_ID, MODULE_NAME } from '../shared.js'

const knowledgeExtension: ModuleDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	version: '0.1.0',
	objectTypes: [
		{
			type: 'knowledge',
			label: 'Knowledge',
			icon: 'book-open',
			defaultStatuses: ['draft', 'review', 'confirmed', 'superseded', 'deprecated'],
			defaultFields: [
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
			defaultRelationshipTypes: [
				'derived_from',
				'extends',
				'contradicts',
				'supports',
				'supersedes',
			],
		},
	],
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

export default knowledgeExtension
