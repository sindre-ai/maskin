import { applyMagicLinkFragment } from './magic-link'

// True when the bundle is running inside the Tauri iOS shell rather than a
// plain browser. Tauri v2 exposes __TAURI_INTERNALS__ on the webview window.
export function isTauri(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// Strips a magic-link fragment (`#key=ank_...&actor_id=...`) out of an arbitrary
// URL — a deep link the OS hands to the shell. Returns the fragment including
// the leading '#', or null when the URL has none or is malformed.
export function magicLinkFragmentFromUrl(url: string): string | null {
	try {
		const hash = new URL(url).hash
		return hash === '' ? null : hash
	} catch {
		return null
	}
}

/**
 * Wires the iOS custom-scheme deep link (maskin://…#key=…&actor_id=…) into the
 * already-bundled magic-link handoff, so a login link opened on the phone lands
 * the user authenticated without pasting a key. Inert in a plain browser: the
 * guard returns before the Tauri plugin is ever loaded, so web deploys are
 * unaffected. The fragment is consumed via the shared applyMagicLinkFragment,
 * then a reload lets the auth guard and workspace router bootstrap with the
 * fresh session.
 */
export function initIosDeepLink(): void {
	if (!isTauri()) return
	// Dynamic import keeps the plugin out of the browser chunk path.
	void import('@tauri-apps/plugin-deep-link')
		.then(({ getCurrent, onOpenUrl }) => {
			const apply = (url: string) => {
				const hash = magicLinkFragmentFromUrl(url)
				if (!hash || !applyMagicLinkFragment(hash)) return
				window.location.href = window.location.pathname + window.location.search
			}
			void getCurrent()
				.then((urls) => {
					for (const url of urls ?? []) apply(url)
				})
				.catch(() => {})
			void onOpenUrl((urls) => {
				for (const url of urls) apply(url)
			}).catch(() => {})
		})
		.catch(() => {})
}
