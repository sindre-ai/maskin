import type { ModuleDefinition } from '@maskin/module-sdk'
import {
	MODULE_ID,
	MODULE_NAME,
	TARGETS_DEFAULT_SETTINGS,
	TARGET_DISPLAY_NAME,
	TARGET_FIELDS,
	TARGET_RELATIONSHIP_TYPES,
	TARGET_STATUSES,
	TARGET_TYPE,
} from '../shared.js'

const targetsExtension: ModuleDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	version: '0.1.0',
	objectTypes: [
		{
			type: TARGET_TYPE,
			label: TARGET_DISPLAY_NAME,
			icon: 'target',
			defaultStatuses: TARGET_STATUSES,
			defaultFields: TARGET_FIELDS,
			defaultRelationshipTypes: TARGET_RELATIONSHIP_TYPES,
		},
	],
	defaultSettings: TARGETS_DEFAULT_SETTINGS,
}

export default targetsExtension
