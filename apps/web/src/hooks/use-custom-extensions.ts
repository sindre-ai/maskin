import { useWorkspace } from '@/lib/workspace-context'
import { useMemo, useRef } from 'react'

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

	const prev = useRef<CustomExtensionInfo[]>([])

	return useMemo(() => {
		const entries = Object.entries(customExtensions)
		if (entries.length === 0) return prev.current.length === 0 ? prev.current : []

		const result = entries.map(([id, ext]) => ({
			id,
			name: ext.name,
			types: ext.types,
			tabs: ext.types.map((type) => ({
				label: displayNames[type] ?? type,
				value: type,
			})),
		}))

		prev.current = result
		return result
	}, [customExtensions, displayNames])
}
