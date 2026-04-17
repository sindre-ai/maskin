import type { ModuleDefinition } from '@maskin/module-sdk'
import {
	KNOWLEDGE_DEFAULT_SETTINGS,
	KNOWLEDGE_FIELDS,
	KNOWLEDGE_RELATIONSHIP_TYPES,
	KNOWLEDGE_STATUSES,
	MODULE_ID,
	MODULE_NAME,
} from '../shared.js'
import { KNOWLEDGE_AGENTS, KNOWLEDGE_TRIGGERS } from './agents.js'

const knowledgeExtension: ModuleDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	version: '0.1.0',
	objectTypes: [
		{
			type: 'knowledge',
			label: 'Article',
			icon: 'book-open',
			defaultStatuses: [...KNOWLEDGE_STATUSES],
			defaultFields: KNOWLEDGE_FIELDS,
			defaultRelationshipTypes: KNOWLEDGE_RELATIONSHIP_TYPES,
		},
	],
	defaultSettings: KNOWLEDGE_DEFAULT_SETTINGS,
	seedAgents: KNOWLEDGE_AGENTS,
	seedTriggers: KNOWLEDGE_TRIGGERS,
}

export default knowledgeExtension
