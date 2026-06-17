import type { ModuleWebDefinition } from '@maskin/module-sdk'
import {
	CHANGELOG_DEFAULT_SETTINGS,
	CHANGELOG_ENTRY_TYPE,
	MODULE_ID,
	MODULE_NAME,
} from '../shared.js'

const changelogWebExtension: ModuleWebDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	navItems: [],
	objectTypeTabs: [{ label: 'Changelog', value: CHANGELOG_ENTRY_TYPE }],
	defaultSettings: CHANGELOG_DEFAULT_SETTINGS,
}

export default changelogWebExtension
