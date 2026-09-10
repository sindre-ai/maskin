// Session-scoped dedup for `foryou_card_shown`. A component-scoped `useRef`
// guard fires on every mount, so navigating away from /$workspaceId/ and back
// re-emits an impression for every card in the feed — the 5-8x impressions/card
// inflation that broke the engagement rate reading since Aug 25. Module-level
// state clears on hard reload / new tab, which IS the correct "session" boundary
// for this event — no sessionStorage / localStorage persistence (a card the
// same reader reopened in a new tab is genuinely a new impression). Returns
// true the first time a given card is seen and false on every subsequent call.
const seen = new Set<string>()

export function markImpressed(cardId: string): boolean {
	if (seen.has(cardId)) return false
	seen.add(cardId)
	return true
}

// Test-only helper; nothing in the app should ever clear the set at runtime.
export function __resetImpressionsForTesting(): void {
	seen.clear()
}
