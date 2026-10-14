import {
	DEFAULT_VIEWER_PREFERENCES,
	VIEWER_PREFERENCES_KEY_PREFIX,
	parseViewerPreferences,
	readViewerPreferences,
	serializeViewerPreferences,
	viewerPreferencesKey,
	writeViewerPreferences,
} from '@/lib/viewer-preferences'
import { beforeEach, describe, expect, it } from 'vitest'

const FILE_ID = 'file-slice-2c'

beforeEach(() => {
	window.localStorage.clear()
})

describe('viewer-preferences', () => {
	describe('viewerPreferencesKey', () => {
		it('namespaces each file id under the shared prefix', () => {
			expect(viewerPreferencesKey(FILE_ID)).toBe(`${VIEWER_PREFERENCES_KEY_PREFIX}${FILE_ID}`)
		})
	})

	describe('parseViewerPreferences', () => {
		it('returns defaults for a missing entry', () => {
			expect(parseViewerPreferences(null)).toEqual(DEFAULT_VIEWER_PREFERENCES)
		})

		it('returns defaults for malformed JSON', () => {
			expect(parseViewerPreferences('not-json')).toEqual(DEFAULT_VIEWER_PREFERENCES)
		})

		it('accepts a fully-shaped payload', () => {
			expect(
				parseViewerPreferences(
					JSON.stringify({ variantOverride: 'mockup', mockupPreset: 'phone' }),
				),
			).toEqual({ variantOverride: 'mockup', mockupPreset: 'phone' })
		})

		it('falls back to defaults for unknown enum values', () => {
			expect(
				parseViewerPreferences(
					JSON.stringify({ variantOverride: 'bogus', mockupPreset: 'widescreen' }),
				),
			).toEqual(DEFAULT_VIEWER_PREFERENCES)
		})

		it('keeps the valid half of a partial payload', () => {
			expect(parseViewerPreferences(JSON.stringify({ mockupPreset: 'tablet' }))).toEqual({
				variantOverride: DEFAULT_VIEWER_PREFERENCES.variantOverride,
				mockupPreset: 'tablet',
			})
		})
	})

	// Round-trip: what we write is what we read back (spec: "View-as override
	// round-trips through the persistence key" — same guarantee covers the
	// preset).
	describe('write → read round-trip', () => {
		it('mockup override survives a reload', () => {
			writeViewerPreferences(FILE_ID, { variantOverride: 'mockup', mockupPreset: 'phone' })
			expect(readViewerPreferences(FILE_ID)).toEqual({
				variantOverride: 'mockup',
				mockupPreset: 'phone',
			})
		})

		it('deck override survives a reload', () => {
			writeViewerPreferences(FILE_ID, { variantOverride: 'deck', mockupPreset: 'tablet' })
			expect(readViewerPreferences(FILE_ID)).toEqual({
				variantOverride: 'deck',
				mockupPreset: 'tablet',
			})
		})

		it('null override (auto) survives a reload', () => {
			writeViewerPreferences(FILE_ID, { variantOverride: null, mockupPreset: 'desktop' })
			expect(readViewerPreferences(FILE_ID)).toEqual(DEFAULT_VIEWER_PREFERENCES)
		})

		it('is namespaced per fileId — other files stay on defaults', () => {
			writeViewerPreferences(FILE_ID, { variantOverride: 'mockup', mockupPreset: 'phone' })
			expect(readViewerPreferences('other-file')).toEqual(DEFAULT_VIEWER_PREFERENCES)
		})

		it('writes the serialized payload under the expected key', () => {
			writeViewerPreferences(FILE_ID, { variantOverride: 'mockup', mockupPreset: 'tablet' })
			expect(window.localStorage.getItem(viewerPreferencesKey(FILE_ID))).toBe(
				serializeViewerPreferences({ variantOverride: 'mockup', mockupPreset: 'tablet' }),
			)
		})
	})
})
