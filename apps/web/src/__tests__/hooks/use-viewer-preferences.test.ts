import { useViewerPreferences } from '@/hooks/use-viewer-preferences'
import {
	DEFAULT_VIEWER_PREFERENCES,
	VIEWER_PREFERENCES_KEY_PREFIX,
	readViewerPreferences,
} from '@/lib/viewer-preferences'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

const FILE_ID = 'file-slice-2c-hook'

beforeEach(() => {
	window.localStorage.clear()
})

describe('useViewerPreferences', () => {
	it('seeds with defaults when nothing is stored', () => {
		const { result } = renderHook(() => useViewerPreferences(FILE_ID))
		expect(result.current.variantOverride).toBe(DEFAULT_VIEWER_PREFERENCES.variantOverride)
		expect(result.current.mockupPreset).toBe(DEFAULT_VIEWER_PREFERENCES.mockupPreset)
	})

	it('persists the variant override on set and re-reads it on rerender', () => {
		const { result, rerender } = renderHook(() => useViewerPreferences(FILE_ID))
		act(() => result.current.setVariantOverride('mockup'))
		expect(result.current.variantOverride).toBe('mockup')
		expect(readViewerPreferences(FILE_ID).variantOverride).toBe('mockup')

		// A rerender with the same fileId (i.e. reopen the page) still reads the
		// override from storage rather than falling back to auto — this is the
		// spec's "survives a reload" property.
		rerender()
		expect(result.current.variantOverride).toBe('mockup')
	})

	it('persists the mockup preset on set', () => {
		const { result } = renderHook(() => useViewerPreferences(FILE_ID))
		act(() => result.current.setMockupPreset('phone'))
		expect(result.current.mockupPreset).toBe('phone')
		expect(readViewerPreferences(FILE_ID).mockupPreset).toBe('phone')
	})

	it('scopes state per fileId — flipping fileId does not leak state', () => {
		window.localStorage.setItem(
			`${VIEWER_PREFERENCES_KEY_PREFIX}file-a`,
			JSON.stringify({ variantOverride: 'mockup', mockupPreset: 'phone' }),
		)
		window.localStorage.setItem(
			`${VIEWER_PREFERENCES_KEY_PREFIX}file-b`,
			JSON.stringify({ variantOverride: 'deck', mockupPreset: 'tablet' }),
		)

		const { result, rerender } = renderHook(({ id }: { id: string }) => useViewerPreferences(id), {
			initialProps: { id: 'file-a' },
		})
		expect(result.current.variantOverride).toBe('mockup')
		expect(result.current.mockupPreset).toBe('phone')

		rerender({ id: 'file-b' })
		expect(result.current.variantOverride).toBe('deck')
		expect(result.current.mockupPreset).toBe('tablet')
	})
})
