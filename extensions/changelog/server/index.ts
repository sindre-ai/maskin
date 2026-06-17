import type { ModuleDefinition } from '@maskin/module-sdk'
import {
	CHANGELOG_DEFAULT_SETTINGS,
	CHANGELOG_ENTRY_DISPLAY_NAME,
	CHANGELOG_ENTRY_FIELDS,
	CHANGELOG_ENTRY_STATUSES,
	CHANGELOG_ENTRY_TYPE,
	MODULE_ID,
	MODULE_NAME,
} from '../shared.js'

const changelogExtension: ModuleDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	version: '0.1.0',
	objectTypes: [
		{
			type: CHANGELOG_ENTRY_TYPE,
			label: CHANGELOG_ENTRY_DISPLAY_NAME,
			icon: 'newspaper',
			defaultStatuses: CHANGELOG_ENTRY_STATUSES,
			defaultFields: CHANGELOG_ENTRY_FIELDS,
		},
	],
	defaultSettings: CHANGELOG_DEFAULT_SETTINGS,
}

export default changelogExtension
