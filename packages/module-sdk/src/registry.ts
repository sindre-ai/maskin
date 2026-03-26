import type {
	ModuleDefinition,
	ModuleWebDefinition,
	NavItemDefinition,
	ObjectTypeTab,
} from './types.js'

/** Isolated module registry — each instance has its own set of modules. */
export class ModuleRegistry {
	private modules = new Map<string, ModuleDefinition>()

	/** Register a module. Silently replaces if a module with the same ID is already registered (supports HMR). */
	register(mod: ModuleDefinition): void {
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

	/** Get all valid object types: module-provided types + custom types defined in workspace settings */
	getAllValidTypes(
		enabledModuleIds: string[],
		settings?: { statuses?: Record<string, string[]> },
	): string[] {
		const moduleTypes = this.getValidObjectTypes(enabledModuleIds)
		const settingsTypes = settings?.statuses ? Object.keys(settings.statuses) : []
		return [...new Set([...moduleTypes, ...settingsTypes])]
	}

	/** Get default settings to merge when enabling a module */
	getModuleDefaultSettings(moduleId: string): ModuleDefinition['defaultSettings'] {
		return this.modules.get(moduleId)?.defaultSettings
	}

	/** Get the default status for an object type from the module that provides it */
	getDefaultStatusForType(type: string): string | undefined {
		for (const mod of this.modules.values()) {
			const objType = mod.objectTypes.find((t) => t.type === type)
			if (objType) return objType.defaultStatuses[0]
		}
		return undefined
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

export function getAllValidTypes(
	enabledModuleIds: string[],
	settings?: { statuses?: Record<string, string[]> },
): string[] {
	return defaultRegistry.getAllValidTypes(enabledModuleIds, settings)
}

export function getModuleDefaultSettings(moduleId: string) {
	return defaultRegistry.getModuleDefaultSettings(moduleId)
}

export function getDefaultStatusForType(type: string): string | undefined {
	return defaultRegistry.getDefaultStatusForType(type)
}

/** Extract enabled module IDs from workspace settings, defaulting to ['work'] */
export function getEnabledModuleIds(
	settings: Record<string, unknown> | null | undefined,
): string[] {
	const raw = settings?.enabled_modules
	return Array.isArray(raw) ? raw : ['work']
}

export function clearModules(): void {
	defaultRegistry.clear()
}

// ── Frontend module registry ───────────────────────────────────────

const webModules = new Map<string, ModuleWebDefinition>()

/** Register a frontend module definition. Silently replaces if already registered (supports HMR). */
export function registerWebModule(mod: ModuleWebDefinition): void {
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
