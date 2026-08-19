import type { ModuleWebDefinition } from '@maskin/module-sdk'
import { KNOWLEDGE_DEFAULT_SETTINGS, MODULE_ID, MODULE_NAME } from '../shared.js'

const knowledgeWebExtension: ModuleWebDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	navItems: [],
	objectTypeTabs: [{ label: 'Knowledge', value: 'knowledge' }],
	defaultSettings: KNOWLEDGE_DEFAULT_SETTINGS,
}

export default knowledgeWebExtension
