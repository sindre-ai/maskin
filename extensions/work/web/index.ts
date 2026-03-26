import type { ModuleWebDefinition } from '@ai-native/module-sdk'

const workWebExtension: ModuleWebDefinition = {
	id: 'work',
	name: 'Work',
	navItems: [],
	objectTypeTabs: [
		{ label: 'Insights', value: 'insight' },
		{ label: 'Bets', value: 'bet' },
		{ label: 'Tasks', value: 'task' },
	],
}

export default workWebExtension
