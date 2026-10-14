import {
	MOCKUP_VIEWPORT_PRESETS,
	type MockupViewportPreset,
	type ViewerVariantOverride,
} from './viewer-detect'

// Per-file viewer preferences: the manual "View as…" override on top of the
// filename+DOM auto-detect, plus the mockup viewport preset. Persisted to
// localStorage so a reload preserves the user's choice (spec criterion 4).
export interface ViewerFilePreferences {
	variantOverride: ViewerVariantOverride
	mockupPreset: MockupViewportPreset
}

export const DEFAULT_MOCKUP_PRESET: MockupViewportPreset = 'desktop'

export const DEFAULT_VIEWER_PREFERENCES: ViewerFilePreferences = {
	variantOverride: null,
	mockupPreset: DEFAULT_MOCKUP_PRESET,
}

// Namespace-per-file, matching the pinned-files pattern's single-purpose keys.
// Anything else on the localStorage keyspace stays clear of this prefix.
export const VIEWER_PREFERENCES_KEY_PREFIX = 'viewer-prefs:'

export function viewerPreferencesKey(fileId: string): string {
	return `${VIEWER_PREFERENCES_KEY_PREFIX}${fileId}`
}

function isViewerVariantOverride(value: unknown): value is ViewerVariantOverride {
	return value === null || value === 'deck' || value === 'mockup' || value === 'single'
}

function isMockupViewportPreset(value: unknown): value is MockupViewportPreset {
	return typeof value === 'string' && value in MOCKUP_VIEWPORT_PRESETS
}

// Any malformed / partial stored value degrades to the default, so a hand-edited
// or older-shape entry can never crash the viewer on open (same posture as
// pinned-files.ts).
export function parseViewerPreferences(raw: string | null): ViewerFilePreferences {
	if (!raw) return DEFAULT_VIEWER_PREFERENCES
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return DEFAULT_VIEWER_PREFERENCES
	}
	if (!parsed || typeof parsed !== 'object') return DEFAULT_VIEWER_PREFERENCES
	const obj = parsed as Record<string, unknown>
	return {
		variantOverride: isViewerVariantOverride(obj.variantOverride)
			? obj.variantOverride
			: DEFAULT_VIEWER_PREFERENCES.variantOverride,
		mockupPreset: isMockupViewportPreset(obj.mockupPreset)
			? obj.mockupPreset
			: DEFAULT_VIEWER_PREFERENCES.mockupPreset,
	}
}

export function serializeViewerPreferences(prefs: ViewerFilePreferences): string {
	return JSON.stringify(prefs)
}

export function readViewerPreferences(fileId: string): ViewerFilePreferences {
	if (typeof window === 'undefined') return DEFAULT_VIEWER_PREFERENCES
	try {
		return parseViewerPreferences(window.localStorage.getItem(viewerPreferencesKey(fileId)))
	} catch {
		return DEFAULT_VIEWER_PREFERENCES
	}
}

export function writeViewerPreferences(fileId: string, prefs: ViewerFilePreferences): void {
	if (typeof window === 'undefined') return
	try {
		window.localStorage.setItem(viewerPreferencesKey(fileId), serializeViewerPreferences(prefs))
	} catch {
		// Storage may be full or blocked (private mode); a failed write silently
		// degrades to session-only prefs rather than crashing the viewer.
	}
}
