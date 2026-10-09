/**
 * R11-B · Mock handlers for LinkedIn v2 destructive post CRUD.
 *
 * Wire-shape reference:
 *   - PATCH  /v2/{account_id}/posts/{post_id}  →  200 { object: 'PostUpdated', post_id, edited_at }
 *   - DELETE /v2/{account_id}/posts/{post_id}  →  204 no-content
 *
 * Both routes have an error variant toggleable via `setNextPostsCrudError`
 * that returns LinkedIn's POST_NOT_FOUND envelope — same wire body the live
 * API returns when a post is missing, already deleted, or authored by a
 * different identity. Toggle is single-shot so a test can pin one error
 * without polluting subsequent requests.
 *
 * The routes are intentionally kept in this file (rather than folded into
 * `unipile-server.ts`) so a future addition — reactions CRUD (R11-C follow-on),
 * message CRUD, etc. — has a clear pattern to slot into: one file per surface,
 * imported and dispatched by the main mock switch.
 *
 * DO NOT ship real Unipile calls in CI. This handler is the ONLY response
 * shape the CRUD test suite ever sees from these two routes.
 */

/** Wire envelope for a POST_NOT_FOUND from LinkedIn v2 on either CRUD route. */
export const CANNED_POST_NOT_FOUND_ERROR = () => ({
	object: 'Error',
	error_code: 'post_not_found',
	message: 'The post you are trying to modify could not be found for this LinkedIn account.',
})

/** Wire envelope for a successful PATCH on a post — Unipile v2 shape. */
export const CANNED_EDIT_POST_RESPONSE = (postId: string) => ({
	object: 'PostUpdated',
	post_id: postId,
	edited_at: '2026-09-02T10:15:00.000Z',
})

/**
 * Toggle values a test can pass to `setNextPostsCrudError` to force a specific
 * error envelope on the next matching request. Kept as string literals rather
 * than a union of arbitrary shapes so a typo in the test surfaces at type-check
 * time, not as a silently-served 200.
 */
export type PostsCrudErrorTrigger = 'post-not-found'

type Pending = { trigger: PostsCrudErrorTrigger }
let pending: Pending | null = null

/**
 * Plant a single-shot override for the NEXT PATCH or DELETE against a post.
 * Consumed by the handler when it matches (the override then clears itself),
 * so a test can pin an error for one call and expect the following one to hit
 * the happy path.
 *
 * `mock.setNext('post-not-found')` in the spec's naming; this helper is the
 * concrete implementation of that toggle.
 */
export function setNextPostsCrudError(trigger: PostsCrudErrorTrigger): void {
	pending = { trigger }
}

/** Test-only: clear any pending override without running a request through the handler. */
export function clearPostsCrudPending(): void {
	pending = null
}

export type PostsCrudResult = {
	status: number
	body: unknown
}

/**
 * Dispatch a request against the LinkedIn v2 post CRUD surface. Returns
 * `null` when the (method, path) pair does not match either CRUD route, so
 * the caller can chain other handlers. `_postId` is captured on the delete
 * path so a real handler could echo it back; we do not, because the live API
 * returns 204 with an empty body.
 */
export function tryHandlePostsCrud(method: string, path: string): PostsCrudResult | null {
	const editMatch = path.match(/^\/v2\/[^/]+\/posts\/([^/?]+)(?:\?.*)?$/)
	if (!editMatch) return null

	const postId = editMatch[1] as string

	if (method === 'PATCH') {
		if (pending) {
			const { trigger } = pending
			pending = null
			if (trigger === 'post-not-found') {
				return { status: 400, body: CANNED_POST_NOT_FOUND_ERROR() }
			}
		}
		return { status: 200, body: CANNED_EDIT_POST_RESPONSE(postId) }
	}

	if (method === 'DELETE') {
		if (pending) {
			const { trigger } = pending
			pending = null
			if (trigger === 'post-not-found') {
				return { status: 400, body: CANNED_POST_NOT_FOUND_ERROR() }
			}
		}
		// Live LinkedIn returns 204 no-content. Emit a bare {} body so the
		// mock's JSON writer has something to serialise (the client tolerates
		// an empty body either way — this is closer to the live shape than
		// returning `undefined`).
		return { status: 204, body: {} }
	}

	return null
}
