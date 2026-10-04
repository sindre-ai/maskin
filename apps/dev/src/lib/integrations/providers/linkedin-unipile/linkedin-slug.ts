/**
 * LinkedIn profile slug helpers.
 *
 * Contacts store only `linkedin_url`, so matching a person to a contact means
 * comparing the path segment after `/in/`. The comparison is EQUALITY on that
 * segment, never substring: "martin" must not match
 * "martin-emil-sloth-55a6655".
 */

/**
 * Normalised slug for a LinkedIn profile URL, or null when the input is not a
 * `/in/<slug>` URL. Lowercases, drops the query string and fragment, drops a
 * trailing slash and url-decodes the segment.
 */
export function slugFromLinkedinUrl(url: string | null | undefined): string | null {
	if (typeof url !== 'string') return null
	const withoutQuery = url.trim().split(/[?#]/)[0] ?? ''
	const lowered = withoutQuery.toLowerCase()
	const marker = '/in/'
	const at = lowered.indexOf(marker)
	if (at === -1) return null
	const rest = lowered.slice(at + marker.length)
	const segment = rest.split('/')[0] ?? ''
	if (!segment) return null
	let decoded = segment
	try {
		decoded = decodeURIComponent(segment)
	} catch {
		// Malformed escape: compare the raw segment rather than dropping the match.
	}
	const slug = decoded.trim()
	return slug.length > 0 ? slug : null
}

/** True when both URLs carry the same `/in/` slug. Null on either side is never a match. */
export function sameLinkedinSlug(
	a: string | null | undefined,
	b: string | null | undefined,
): boolean {
	const slugA = slugFromLinkedinUrl(a)
	const slugB = slugFromLinkedinUrl(b)
	return slugA !== null && slugA === slugB
}
