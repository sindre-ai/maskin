import { registerWebModule } from '@ai-native/module-sdk'

// Register the Work module for the frontend
registerWebModule({
	id: 'work',
	name: 'Work',
	navItems: [{ label: 'Objects', path: 'objects', icon: 'layers' }],
	objectTypeTabs: [
		{ label: 'Insights', value: 'insight' },
		{ label: 'Bets', value: 'bet' },
		{ label: 'Tasks', value: 'task' },
	],
})
