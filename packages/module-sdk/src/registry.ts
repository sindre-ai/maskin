import type {
	ModuleDefinition,
	ModuleWebDefinition,
	NavItemDefinition,
	ObjectTypeTab,
} from './types.js'

const modules = new Map<string, ModuleDefinition>()

/** Register a module. Throws if a module with the same ID is already registered. */
export function registerModule(mod: ModuleDefinition): void {
	if (modules.has(mod.id)) {
		throw new Error(`Module "${mod.id}" is already registered`)
	}
	modules.set(mod.id, mod)
}

/** Get a module by ID */
export function getModule(id: string): ModuleDefinition | undefined {
	return modules.get(id)
}

/** Get all registered modules */
export function getAllModules(): ModuleDefinition[] {
	return Array.from(modules.values())
}

/** Get all object types from all registered modules */
export function getAllObjectTypes(): Array<{
	moduleId: string
	type: string
	label: string
	icon: string
}> {
	return getAllModules().flatMap((mod) =>
		mod.objectTypes.map((t) => ({
			moduleId: mod.id,
			type: t.type,
			label: t.label,
			icon: t.icon,
		})),
	)
}

/** Get valid object types for a set of enabled module IDs */
export function getValidObjectTypes(enabledModuleIds: string[]): string[] {
	return getAllModules()
		.filter((m) => enabledModuleIds.includes(m.id))
		.flatMap((m) => m.objectTypes.map((t) => t.type))
}

/** Get default settings to merge when enabling a module */
export function getModuleDefaultSettings(moduleId: string): ModuleDefinition['defaultSettings'] {
	return modules.get(moduleId)?.defaultSettings
}

/** Clear all registered modules (useful for testing) */
export function clearModules(): void {
	modules.clear()
}

// ── Frontend module registry ───────────────────────────────────────

const webModules = new Map<string, ModuleWebDefinition>()

/** Register a frontend module definition */
export function registerWebModule(mod: ModuleWebDefinition): void {
	if (webModules.has(mod.id)) {
		throw new Error(`Web module "${mod.id}" is already registered`)
	}
	webModules.set(mod.id, mod)
}

/** Get all registered frontend modules */
export function getAllWebModules(): ModuleWebDefinition[] {
	return Array.from(webModules.values())
}

/** Get a frontend module by ID */
export function getWebModule(id: string): ModuleWebDefinition | undefined {
	return webModules.get(id)
}

/** Get nav items from all enabled modules */
export function getEnabledNavItems(enabledModuleIds: string[]): NavItemDefinition[] {
	return getAllWebModules()
		.filter((m) => enabledModuleIds.includes(m.id))
		.flatMap((m) => m.navItems)
}

/** Get object type tabs from all enabled modules */
export function getEnabledObjectTypeTabs(enabledModuleIds: string[]): ObjectTypeTab[] {
	return getAllWebModules()
		.filter((m) => enabledModuleIds.includes(m.id))
		.flatMap((m) => m.objectTypeTabs)
}

/** Clear all frontend modules (for testing) */
export function clearWebModules(): void {
	webModules.clear()
}
