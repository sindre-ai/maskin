import type { ObjectTypeDefinition } from '../schemas/workspaces'

type LegacySettings = {
	object_types?: ObjectTypeDefinition[]
	statuses?: Record<string, string[]>
	display_names?: Record<string, string>
	field_definitions?: Record<string, Array<{ name: string; type: string; required?: boolean; values?: string[] }>>
}

export function getObjectTypes(settings: LegacySettings): ObjectTypeDefinition[] {
	if (settings.object_types && settings.object_types.length > 0) {
		return settings.object_types
	}
	// Backwards compat: derive from old statuses/display_names/field_definitions
	const statuses = settings.statuses ?? {}
	return Object.keys(statuses).map((slug) => ({
		slug,
		display_name: settings.display_names?.[slug] ?? slug,
		statuses: statuses[slug] ?? [],
		field_definitions: (settings.field_definitions?.[slug] ?? []) as ObjectTypeDefinition['field_definitions'],
		source: 'core' as const,
	}))
}

export function getTypeDefinition(settings: LegacySettings, slug: string): ObjectTypeDefinition | undefined {
	return getObjectTypes(settings).find((t) => t.slug === slug)
}

export function getValidTypeSlugs(settings: LegacySettings): string[] {
	return getObjectTypes(settings).map((t) => t.slug)
}
