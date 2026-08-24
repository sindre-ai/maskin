// The sidebar's release announcement card (mockup lines 85–92). Dismissal is
// per version and lives in localStorage, so shipping a new `CURRENT_RELEASE`
// re-surfaces the card without a server round-trip.

export interface ReleaseNote {
	version: string
	title: string
	summary: string
	href?: string
}

export const CURRENT_RELEASE: ReleaseNote = {
	version: '2.32',
	title: 'Version 2.32 is live',
	summary: 'A rebuilt sidebar, top nav and command palette — faster to get anywhere.',
}

function storageKey(version: string): string {
	return `maskin-release-dismissed-${version}`
}

export function isReleaseDismissed(version: string): boolean {
	try {
		return localStorage.getItem(storageKey(version)) === '1'
	} catch {
		return false
	}
}

export function dismissRelease(version: string): void {
	try {
		localStorage.setItem(storageKey(version), '1')
	} catch {
		// Dismissal is best-effort; a full/privacy-mode storage must never throw.
	}
}
