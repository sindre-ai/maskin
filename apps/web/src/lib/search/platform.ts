// The shortcut as the person's keyboard prints it, for the hints on the search
// surfaces. The shortcuts themselves already accept Cmd or Ctrl.

function isApplePlatform(): boolean {
	if (typeof navigator === 'undefined') return false
	const platform =
		(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
		navigator.platform ??
		''
	return /Mac|iPhone|iPad|iPod/i.test(platform)
}

/** "⌘K" on a Mac, "Ctrl+K" everywhere else. */
export function shortcutLabel(key: string): string {
	return isApplePlatform() ? `⌘${key}` : `Ctrl+${key}`
}
