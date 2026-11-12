// Relevance constants and the LIKE-pattern helper shared by GET /api/objects/search
// (routes/objects.ts) and GET /api/search (services/search.ts), so the two rank the
// same way.

// Per-token rank weight for a title hit; a content hit is worth 1. A title
// match therefore outranks any content-only match for realistic queries
// (fewer than 1000 tokens), while more matched tokens still rank higher.
export const TITLE_HIT_WEIGHT = 1000

// A title hit also earns up to this many points for the share of the title the
// token covers, so "hans" ranks "Hans" (100%) above "Hans Solutions" (~29%).
// Kept below TITLE_HIT_WEIGHT so coverage never outranks an extra matched token.
export const TITLE_COVERAGE_SCALE = 100

// A title that contains the whole typed phrase starting at a word boundary
// ("anna b" → "Anna Baker") earns this on top of the token hits. Needed
// because the tokenizer drops terms under 3 chars, so "b" would otherwise not
// influence the order at all. Between one and two token hits, so it beats the
// coverage bonus but never an extra matched token.
export const TITLE_PHRASE_PREFIX_BONUS = 500

// A participant name that hits is worth TITLE_HIT_WEIGHT, the same as a title hit, so a chat
// found by who is in it is not buried under chats that merely hold the letters. A whole-word
// name match ("cpo" in "CPO" or "Ask CPO") and a name word that starts with the token earn
// these on top, the same tiers as TeamLayout.searchTier on iOS. Both stay below
// TITLE_HIT_WEIGHT so they never outrank an extra matched token.
export const NAME_WHOLE_WORD_BONUS = 400
export const NAME_WORD_PREFIX_BONUS = 200

/** `%token%` with LIKE wildcards in the token escaped. */
export function tokenIlikePattern(token: string): string {
	return `%${token.replace(/[%_\\]/g, '\\$&')}%`
}

/** `token` with regex metacharacters escaped, for the name-word patterns of a participant list. */
export function tokenRegexEscape(token: string): string {
	return token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
