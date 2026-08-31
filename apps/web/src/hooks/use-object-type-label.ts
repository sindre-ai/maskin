import { useWorkspace } from '@/lib/workspace-context'
import { useCallback } from 'react'

/** Title-cases a raw type key for a workspace that has no display name for it
 *  (a custom extension added outside the settings UI, or a legacy row whose
 *  type was removed). `knowledge_base` → `Knowledge base`. */
function titleCase(type: string): string {
	const spaced = type.replace(/[_-]+/g, ' ')
	return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * Resolves an object type key to the workspace's *singular* display name —
 * `knowledge` → `Article`, `company` → `Company`.
 *
 * Distinct from `useAvailableObjectTypes()`, whose labels are the plural tab
 * captions ("Articles", "Companies"). A row's type column names one object, so
 * it needs the singular; a tab names a collection, so it needs the plural.
 */
export function useObjectTypeLabel(): (type: string) => string {
	const { workspace } = useWorkspace()
	const displayNames = (
		workspace.settings as { display_names?: Record<string, string> } | undefined
	)?.display_names

	return useCallback((type: string) => displayNames?.[type] ?? titleCase(type), [displayNames])
}
