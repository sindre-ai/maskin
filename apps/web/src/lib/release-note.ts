/**
 * The release note the For You feed announces (Feed v4's `relShow` card, which
 * replaced the sidebar's version card). Bump `version` to re-surface it for
 * everyone — dismissal is stored per version, so an old dismissal never
 * suppresses a new note.
 */
export interface ReleaseChange {
	text: string
	/** Optional inline link at the end of the line ("See it on …"). */
	link?: { label: string; href: string }
}

export interface ReleaseNote {
	version: string
	headline: string
	/** One line per user-visible change. Empty renders the headline alone. */
	changes: ReleaseChange[]
	/** The closing reassurance line, e.g. what the reader does *not* have to do. */
	note?: string
}

export const CURRENT_RELEASE: ReleaseNote = {
	version: '2.32',
	headline: 'Faster briefs, and the feed catches you up in one column',
	changes: [],
}

function storageKey(version: string): string {
	return `maskin-release-dismissed-${version}`
}

export function isReleaseDismissed(version: string): boolean {
	try {
		return localStorage.getItem(storageKey(version)) === '1'
	} catch {
		// Privacy-mode/full storage: show the card rather than crash the feed.
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
