import { afterEach, describe, expect, it } from 'vitest'
import {
	ModuleRegistry,
	clearModules,
	clearWebModules,
	getAllModules,
	getAllWebModules,
	getDefaultStatusForType,
	getEnabledModuleIds,
	getEnabledNavItems,
	getEnabledObjectTypeTabs,
	getModule,
	getValidObjectTypes,
	getWebModule,
	registerModule,
	registerWebModule,
} from '../registry'
import type { ModuleDefinition, ModuleWebDefinition } from '../types'

const mockModule: ModuleDefinition = {
	id: 'work',
	name: 'Work',
	version: '0.1.0',
	objectTypes: [
		{
			type: 'insight',
			label: 'Insight',
			icon: 'lightbulb',
			defaultStatuses: ['new', 'processing'],
		},
		{ type: 'bet', label: 'Bet', icon: 'target', defaultStatuses: ['signal', 'active'] },
		{ type: 'task', label: 'Task', icon: 'check-square', defaultStatuses: ['todo', 'done'] },
	],
}

const mockModule2: ModuleDefinition = {
	id: 'crm',
	name: 'CRM',
	version: '0.1.0',
	objectTypes: [
		{ type: 'contact', label: 'Contact', icon: 'user', defaultStatuses: ['active', 'archived'] },
	],
}

const mockWebModule: ModuleWebDefinition = {
	id: 'work',
	name: 'Work',
	navItems: [{ label: 'Board', path: 'board', icon: 'layout' }],
	objectTypeTabs: [
		{ label: 'Insights', value: 'insight' },
		{ label: 'Bets', value: 'bet' },
	],
}

const mockWebModule2: ModuleWebDefinition = {
	id: 'crm',
	name: 'CRM',
	navItems: [{ label: 'Contacts', path: 'contacts', icon: 'users' }],
	objectTypeTabs: [{ label: 'Contacts', value: 'contact' }],
}

afterEach(() => {
	clearModules()
	clearWebModules()
})

describe('ModuleRegistry class', () => {
	it('registers and retrieves a module by ID', () => {
		const registry = new ModuleRegistry()
		registry.register(mockModule)
		expect(registry.get('work')).toBe(mockModule)
	})

	it('returns undefined for unregistered module', () => {
		const registry = new ModuleRegistry()
		expect(registry.get('nonexistent')).toBeUndefined()
	})

	it('replaces module with same ID (HMR support)', () => {
		const registry = new ModuleRegistry()
		registry.register(mockModule)
		const updated = { ...mockModule, name: 'Work v2' }
		registry.register(updated)
		expect(registry.get('work')?.name).toBe('Work v2')
		expect(registry.getAll()).toHaveLength(1)
	})

	it('returns all registered modules', () => {
		const registry = new ModuleRegistry()
		registry.register(mockModule)
		registry.register(mockModule2)
		expect(registry.getAll()).toHaveLength(2)
	})

	it('returns all object types across modules', () => {
		const registry = new ModuleRegistry()
		registry.register(mockModule)
		registry.register(mockModule2)
		const types = registry.getAllObjectTypes()
		expect(types).toHaveLength(4)
		expect(types.map((t) => t.type)).toEqual(['insight', 'bet', 'task', 'contact'])
	})

	it('returns valid object types only for enabled modules', () => {
		const registry = new ModuleRegistry()
		registry.register(mockModule)
		registry.register(mockModule2)
		expect(registry.getValidObjectTypes(['work'])).toEqual(['insight', 'bet', 'task'])
		expect(registry.getValidObjectTypes(['crm'])).toEqual(['contact'])
		expect(registry.getValidObjectTypes(['work', 'crm'])).toEqual([
			'insight',
			'bet',
			'task',
			'contact',
		])
	})

	it('returns empty array when no modules match', () => {
		const registry = new ModuleRegistry()
		registry.register(mockModule)
		expect(registry.getValidObjectTypes([])).toEqual([])
		expect(registry.getValidObjectTypes(['nonexistent'])).toEqual([])
	})

	it('returns default status for known type', () => {
		const registry = new ModuleRegistry()
		registry.register(mockModule)
		expect(registry.getDefaultStatusForType('insight')).toBe('new')
		expect(registry.getDefaultStatusForType('bet')).toBe('signal')
		expect(registry.getDefaultStatusForType('task')).toBe('todo')
	})

	it('returns undefined for unknown type', () => {
		const registry = new ModuleRegistry()
		registry.register(mockModule)
		expect(registry.getDefaultStatusForType('nonexistent')).toBeUndefined()
	})

	it('returns default settings for a module', () => {
		const registry = new ModuleRegistry()
		const modWithSettings = {
			...mockModule,
			defaultSettings: { statuses: { insight: ['new'] } },
		}
		registry.register(modWithSettings)
		expect(registry.getModuleDefaultSettings('work')).toEqual({ statuses: { insight: ['new'] } })
	})

	it('clears all modules', () => {
		const registry = new ModuleRegistry()
		registry.register(mockModule)
		registry.clear()
		expect(registry.getAll()).toHaveLength(0)
		expect(registry.get('work')).toBeUndefined()
	})
})

describe('global convenience functions', () => {
	it('registerModule and getModule work', () => {
		registerModule(mockModule)
		expect(getModule('work')).toBe(mockModule)
	})

	it('getAllModules returns all registered', () => {
		registerModule(mockModule)
		registerModule(mockModule2)
		expect(getAllModules()).toHaveLength(2)
	})

	it('getValidObjectTypes filters by enabled IDs', () => {
		registerModule(mockModule)
		registerModule(mockModule2)
		expect(getValidObjectTypes(['work'])).toEqual(['insight', 'bet', 'task'])
	})

	it('getDefaultStatusForType delegates to registry', () => {
		registerModule(mockModule)
		expect(getDefaultStatusForType('bet')).toBe('signal')
		expect(getDefaultStatusForType('unknown')).toBeUndefined()
	})

	it('clearModules empties the registry', () => {
		registerModule(mockModule)
		clearModules()
		expect(getAllModules()).toHaveLength(0)
	})
})

describe('getEnabledModuleIds', () => {
	it('extracts enabled_modules from settings', () => {
		expect(getEnabledModuleIds({ enabled_modules: ['work', 'crm'] })).toEqual(['work', 'crm'])
	})

	it('defaults to ["work"] when enabled_modules is missing', () => {
		expect(getEnabledModuleIds({})).toEqual(['work'])
	})

	it('defaults to ["work"] for null settings', () => {
		expect(getEnabledModuleIds(null)).toEqual(['work'])
	})

	it('defaults to ["work"] for undefined settings', () => {
		expect(getEnabledModuleIds(undefined)).toEqual(['work'])
	})
})

describe('web module registry', () => {
	it('registers and retrieves web modules', () => {
		registerWebModule(mockWebModule)
		expect(getWebModule('work')).toBe(mockWebModule)
	})

	it('getAllWebModules returns all registered', () => {
		registerWebModule(mockWebModule)
		registerWebModule(mockWebModule2)
		expect(getAllWebModules()).toHaveLength(2)
	})

	it('replaces web module with same ID (HMR support)', () => {
		registerWebModule(mockWebModule)
		const updated = { ...mockWebModule, name: 'Work v2' }
		registerWebModule(updated)
		expect(getWebModule('work')?.name).toBe('Work v2')
		expect(getAllWebModules()).toHaveLength(1)
	})

	it('getEnabledObjectTypeTabs filters by enabled modules', () => {
		registerWebModule(mockWebModule)
		registerWebModule(mockWebModule2)
		const tabs = getEnabledObjectTypeTabs(['work'])
		expect(tabs).toEqual([
			{ label: 'Insights', value: 'insight' },
			{ label: 'Bets', value: 'bet' },
		])
	})

	it('getEnabledObjectTypeTabs returns empty for no enabled modules', () => {
		registerWebModule(mockWebModule)
		expect(getEnabledObjectTypeTabs([])).toEqual([])
	})

	it('getEnabledNavItems filters by enabled modules', () => {
		registerWebModule(mockWebModule)
		registerWebModule(mockWebModule2)
		const navItems = getEnabledNavItems(['crm'])
		expect(navItems).toEqual([{ label: 'Contacts', path: 'contacts', icon: 'users' }])
	})

	it('clearWebModules empties the registry', () => {
		registerWebModule(mockWebModule)
		clearWebModules()
		expect(getAllWebModules()).toHaveLength(0)
	})
})
