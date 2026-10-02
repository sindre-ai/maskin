export type ViewerVariant = 'deck' | 'mockup' | 'single'

// User's manual "View as…" override in the ⋯ menu, persisted per file.
// `null` means "no override, use auto detection".
export type ViewerVariantOverride = ViewerVariant | null

// Bytes read from the file's HTML for the DOM heuristic fallback. The spec
// caps this at 8KB to keep detection cheap and predictable.
export const HEURISTIC_BYTE_LIMIT = 8_192

const DECK_SUFFIX = '.deck.html'
const MOCKUP_SUFFIX = '.mockup.html'

// (1) Filename suffix — wins outright. `null` = suffix doesn't decide.
export function detectViewerVariantFromFilename(name: string): ViewerVariant | null {
	const lowered = name.toLowerCase()
	if (lowered.endsWith(DECK_SUFFIX)) return 'deck'
	if (lowered.endsWith(MOCKUP_SUFFIX)) return 'mockup'
	return null
}

// (2) First-8KB DOM heuristic fallback. Presence of `[data-slide]`,
// `section.slide`, or ≥3 `[id^="slide"]` → deck; otherwise single.
// Regex over source is deliberate — the spec caps this at 8KB, and parsing a
// full DOM out-of-frame would defeat that budget. It's a heuristic and we
// treat it as such: order of resolution has the manual override on top of it.
export function detectViewerVariantFromDom(html: string): ViewerVariant {
	const head = html.length > HEURISTIC_BYTE_LIMIT ? html.slice(0, HEURISTIC_BYTE_LIMIT) : html
	if (/\sdata-slide(?:=|\s|>)/i.test(head)) return 'deck'
	if (/<section[^>]*\bclass=["'][^"']*\bslide\b[^"']*["']/i.test(head)) return 'deck'
	const idSlideMatches = head.match(/\sid=["']slide[^"']*["']/gi)
	if (idSlideMatches && idSlideMatches.length >= 3) return 'deck'
	return 'single'
}

export interface ResolveViewerVariantArgs {
	filename: string
	html: string
	override: ViewerVariantOverride
}

// Order of resolution (per spec §Deck vs mockup detection):
// (3) manual override wins if set,
// (1) filename suffix wins next,
// (2) 8KB DOM heuristic fallback last.
// The override sits on top so a user's ⋯ › View as… never gets clobbered by
// auto-detect on the next open.
export function resolveViewerVariant(args: ResolveViewerVariantArgs): ViewerVariant {
	if (args.override !== null) return args.override
	const fromName = detectViewerVariantFromFilename(args.filename)
	if (fromName !== null) return fromName
	return detectViewerVariantFromDom(args.html)
}

// Mockup viewport presets — same k math scales the preset box to fit the stage.
export const MOCKUP_VIEWPORT_PRESETS = {
	desktop: { w: 1440, h: 900 },
	tablet: { w: 768, h: 1024 },
	phone: { w: 375, h: 812 },
} as const

export type MockupViewportPreset = keyof typeof MOCKUP_VIEWPORT_PRESETS
