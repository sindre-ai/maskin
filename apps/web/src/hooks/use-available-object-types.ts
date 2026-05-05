import { type ObjectTypeTab, getEnabledObjectTypeTabs } from '@maskin/module-sdk'
import { useRef } from 'react'
import { useCustomExtensions } from './use-custom-extensions'
import { useEnabledModules } from './use-enabled-modules'

/** Every object type a user can pick in this workspace — module-provided + custom extensions.
 *
 * Module tabs win on collision so a custom extension can't shadow a built-in type.
 * Returns a stable reference: the same array identity across renders unless the underlying
 * tabs actually change. This keeps useMemo/useEffect dependencies well-behaved. */
export function useAvailableObjectTypes(): ObjectTypeTab[] {
	const enabledModules = useEnabledModules()
	const customExtensions = useCustomExtensions()

	const moduleTabs = getEnabledObjectTypeTabs(enabledModules)
	const seen = new Set(moduleTabs.map((t) => t.value))
	const customTabs = customExtensions
		.filter((e) => e.enabled)
		.flatMap((e) => e.tabs)
		.filter((t) => !seen.has(t.value))

	const merged = [...moduleTabs, ...customTabs]

	const prevSerialized = useRef('')
	const ref = useRef(merged)
	const serialized = JSON.stringify(merged)
	if (serialized !== prevSerialized.current) {
		prevSerialized.current = serialized
		ref.current = merged
	}
	return ref.current
}
