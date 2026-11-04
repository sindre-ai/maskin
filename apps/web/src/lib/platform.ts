/** True on macOS and iOS, where shortcuts are shown with ⌘ instead of Ctrl. */
export function isApplePlatform(): boolean {
	if (typeof navigator === 'undefined') return false
	return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent ?? '')
}
