import type {
	ModuleDefinition,
	ModuleWebDefinition,
	NavItemDefinition,
	ObjectTypeTab,
} from './types.js'

/** Isolated module registry — each instance has its own set of modules. */
export class ModuleRegistry {
	private modules = new Map<string, ModuleDefinition>()

	/** Register a module. Throws if a module with the same ID is already registered. */
	register(mod: ModuleDefinition): void {
		if (this.modules.has(mod.id)) {
			throw new Error(`Module "${mod.id}" is already registered`)
		}
		this.modules.set(mod.id, mod)
	}

	/** Get a module by ID */
	get(id: string): ModuleDefinition | undefined {
		return this.modules.get(id)
	}

	/** Get all registered modules */
	getAll(): ModuleDefinition[] {
		return Array.from(this.modules.values())
	}

	/** Get all object types from all registered modules */
	getAllObjectTypes(): Array<{
		moduleId: string
		type: string
		label: string
		icon: string
	}> {
		return this.getAll().flatMap((mod) =>
			mod.objectTypes.map((t) => ({
				moduleId: mod.id,
				type: t.type,
				label: t.label,
				icon: t.icon,
			})),
		)
	}

	/** Get valid object types for a set of enabled module IDs */
	getValidObjectTypes(enabledModuleIds: string[]): string[] {
		return this.getAll()
			.filter((m) => enabledModuleIds.includes(m.id))
			.flatMap((m) => m.objectTypes.map((t) => t.type))
	}

	/** Get default settings to merge when enabling a module */
	getModuleDefaultSettings(moduleId: string): ModuleDefinition['defaultSettings'] {
		return this.modules.get(moduleId)?.defaultSettings
	}

	/** Clear all registered modules */
	clear(): void {
		this.modules.clear()
	}
}

// ─── Default global instance + convenience functions ─────────────────────────
// These delegate to a shared default registry for simple single-server usage.
// For tests or multi-instance scenarios, create your own ModuleRegistry instead.
//
// ⚠️ Tests that call registerModule() MUST call clearModules() in afterEach
// to avoid leaking module state between test files.

const defaultRegistry = new ModuleRegistry()

export function registerModule(mod: ModuleDefinition): void {
	defaultRegistry.register(mod)
}

export function getModule(id: string): ModuleDefinition | undefined {
	return defaultRegistry.get(id)
}

export function getAllModules(): ModuleDefinition[] {
	return defaultRegistry.getAll()
}

export function getAllObjectTypes() {
	return defaultRegistry.getAllObjectTypes()
}

export function getValidObjectTypes(enabledModuleIds: string[]): string[] {
	return defaultRegistry.getValidObjectTypes(enabledModuleIds)
}

export function getModuleDefaultSettings(moduleId: string) {
	return defaultRegistry.getModuleDefaultSettings(moduleId)
}

export function clearModules(): void {
	defaultRegistry.clear()
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
