import type { MockupViewportPreset, ViewerVariantOverride } from '@/lib/viewer-detect'
import {
	DEFAULT_VIEWER_PREFERENCES,
	type ViewerFilePreferences,
	readViewerPreferences,
	writeViewerPreferences,
} from '@/lib/viewer-preferences'
import { useCallback, useEffect, useState } from 'react'

export interface UseViewerPreferencesResult extends ViewerFilePreferences {
	setVariantOverride: (next: ViewerVariantOverride) => void
	setMockupPreset: (next: MockupViewportPreset) => void
}

// Per-file preferences kept in localStorage. The state seed reads synchronously
// so a reopen never flashes the auto-detected variant before restoring the
// user's override (same posture as feature-flags.ts's cache seed).
export function useViewerPreferences(fileId: string): UseViewerPreferencesResult {
	const [prefs, setPrefs] = useState<ViewerFilePreferences>(() => readViewerPreferences(fileId))

	useEffect(() => {
		setPrefs(readViewerPreferences(fileId))
	}, [fileId])

	const setVariantOverride = useCallback(
		(next: ViewerVariantOverride) => {
			setPrefs((prev) => {
				const merged = { ...prev, variantOverride: next }
				writeViewerPreferences(fileId, merged)
				return merged
			})
		},
		[fileId],
	)

	const setMockupPreset = useCallback(
		(next: MockupViewportPreset) => {
			setPrefs((prev) => {
				const merged = { ...prev, mockupPreset: next }
				writeViewerPreferences(fileId, merged)
				return merged
			})
		},
		[fileId],
	)

	return {
		variantOverride: prefs.variantOverride ?? DEFAULT_VIEWER_PREFERENCES.variantOverride,
		mockupPreset: prefs.mockupPreset,
		setVariantOverride,
		setMockupPreset,
	}
}
