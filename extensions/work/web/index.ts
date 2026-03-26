import type { ModuleWebDefinition } from '@ai-native/module-sdk'
import { MODULE_ID, MODULE_NAME } from '../shared.js'

const workWebExtension: ModuleWebDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	navItems: [],
	objectTypeTabs: [
		{ label: 'Insights', value: 'insight' },
		{ label: 'Bets', value: 'bet' },
		{ label: 'Tasks', value: 'task' },
	],
}

export default workWebExtension
