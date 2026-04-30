import type { ModuleWebDefinition } from '@maskin/module-sdk'
import { CRM_DEFAULT_SETTINGS, MODULE_ID, MODULE_NAME } from '../shared.js'

const crmWebExtension: ModuleWebDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	navItems: [],
	objectTypeTabs: [
		{ label: 'Contacts', value: 'contact' },
		{ label: 'Companies', value: 'company' },
	],
	defaultSettings: CRM_DEFAULT_SETTINGS,
}

export default crmWebExtension
