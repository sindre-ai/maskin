// The release note the sidebar announces. Bump `version` to re-surface the card
// for everyone — dismissal is stored per version, so an old dismissal never
// suppresses a new note. Set `href` to link out; omit it to render the card
// without a "What's new" link rather than pointing at a dead page.
export interface ReleaseNote {
	version: string
	title: string
	summary: string
	href?: string
}

export const CURRENT_RELEASE: ReleaseNote = {
	version: '2.32',
	title: 'Version 2.32 is live',
	summary: 'Faster briefs, swipe to catch up.',
}

function storageKey(version: string): string {
	return `maskin-release-dismissed-${version}`
}

export function isReleaseDismissed(version: string): boolean {
	try {
		return localStorage.getItem(storageKey(version)) === '1'
	} catch {
		// Privacy-mode/full storage: show the card rather than crash the sidebar.
		return false
	}
}

export function dismissRelease(version: string): void {
	try {
		localStorage.setItem(storageKey(version), '1')
	} catch {
		// Best-effort — the card reappears next session, which is harmless.
	}
}
