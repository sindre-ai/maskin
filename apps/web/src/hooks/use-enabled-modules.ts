import { useWorkspace } from '@/lib/workspace-context'
import { useRef } from 'react'

/** Extract enabled module IDs from workspace settings with a stable array reference */
export function useEnabledModules(): string[] {
	const { workspace } = useWorkspace()
	const settings = workspace.settings as Record<string, unknown>
	const raw = (settings?.enabled_modules as string[]) ?? ['work']
	const ref = useRef(raw)

	// Only update the ref if the actual values changed
	if (raw.join(',') !== ref.current.join(',')) {
		ref.current = raw
	}

	return ref.current
}
