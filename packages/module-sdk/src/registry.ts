import type { ModuleDefinition } from './types.js'

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
