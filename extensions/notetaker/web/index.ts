import type { ModuleWebDefinition } from '@maskin/module-sdk'
import { MODULE_ID, MODULE_NAME, NOTETAKER_DEFAULT_SETTINGS } from '../shared.js'

const notetakerWebExtension: ModuleWebDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	navItems: [],
	objectTypeTabs: [{ label: 'Meetings', value: 'meeting' }],
	defaultSettings: NOTETAKER_DEFAULT_SETTINGS,
}

export default notetakerWebExtension
