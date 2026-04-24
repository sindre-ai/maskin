import type { ModuleDefinition } from '@maskin/module-sdk'
import {
	KNOWLEDGE_AGENTS,
	KNOWLEDGE_DEFAULT_SETTINGS,
	KNOWLEDGE_DISPLAY_NAME,
	KNOWLEDGE_FIELDS,
	KNOWLEDGE_RELATIONSHIP_TYPES,
	KNOWLEDGE_STATUSES,
	KNOWLEDGE_TRIGGERS,
	MODULE_ID,
	MODULE_NAME,
} from '../shared.js'

const knowledgeExtension: ModuleDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	version: '0.1.0',
	objectTypes: [
		{
			type: 'knowledge',
			label: KNOWLEDGE_DISPLAY_NAME,
			icon: 'book-open',
			defaultStatuses: KNOWLEDGE_STATUSES,
			defaultFields: KNOWLEDGE_FIELDS,
			defaultRelationshipTypes: KNOWLEDGE_RELATIONSHIP_TYPES,
		},
	],
	defaultSettings: KNOWLEDGE_DEFAULT_SETTINGS,
	defaultAgents: KNOWLEDGE_AGENTS,
	defaultTriggers: KNOWLEDGE_TRIGGERS,
}

export default knowledgeExtension
