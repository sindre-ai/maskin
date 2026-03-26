import { WORK_OBJECT_TYPES } from '@ai-native/mod-work/shared'
import { registerWebModule } from '@ai-native/module-sdk'

registerWebModule({
	id: 'work',
	name: 'Work',
	navItems: [{ label: 'Objects', path: 'objects', icon: 'layers' }],
	objectTypeTabs: WORK_OBJECT_TYPES.map((t) => ({ label: t.pluralLabel, value: t.type })),
})
