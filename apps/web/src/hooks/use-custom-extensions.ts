import { useWorkspace } from '@/lib/workspace-context'
import { useMemo } from 'react'

interface CustomExtensionEntry {
	name: string
	types: string[]
	relationship_types?: string[]
}

export interface CustomExtensionInfo {
	id: string
	name: string
	types: string[]
	tabs: { label: string; value: string }[]
}

export function useCustomExtensions(): CustomExtensionInfo[] {
	const { workspace } = useWorkspace()
	const settings = workspace.settings as Record<string, unknown>

	const customExtensions = (settings?.custom_extensions ?? {}) as Record<
		string,
		CustomExtensionEntry
	>
	const displayNames = (settings?.display_names ?? {}) as Record<string, string>

	return useMemo(
		() =>
			Object.entries(customExtensions).map(([id, ext]) => {
				const types = Array.isArray(ext.types) ? ext.types : []
				return {
					id,
					name: ext.name,
					types,
					tabs: types.map((type) => ({
						label: displayNames[type] ?? type,
						value: type,
					})),
				}
			}),
		[customExtensions, displayNames],
	)
}
