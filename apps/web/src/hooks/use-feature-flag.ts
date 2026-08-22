import { getFlag, subscribeToFlags } from '@/lib/feature-flags'
import { useCallback, useSyncExternalStore } from 'react'

/**
 * Reads a backend-resolved feature flag. Always a plain boolean — never
 * undefined, and no loading state is exposed: before the first successful fetch
 * every flag is false, and a background revalidation that changes the value
 * re-renders the caller.
 */
export function useFeatureFlag(flagId: string): boolean {
	const getSnapshot = useCallback(() => getFlag(flagId), [flagId])
	return useSyncExternalStore(subscribeToFlags, getSnapshot, getSnapshot)
}
