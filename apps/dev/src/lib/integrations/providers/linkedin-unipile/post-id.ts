import { LinkedInIntegrationError } from './errors'

/**
 * Post id forms read_post_comments and get_post_engagement accept. Callers get
 * a post id from list_user_posts, but also from a pasted URL, a note or a
 * stored content object, so the reads take all of these.
 */
export const POST_ID_ACCEPTED_FORMS =
	'the post_id list_user_posts returned, a bare activity number (7519434747178049536), ' +
	'urn:li:activity:<number>, or a linkedin.com post URL that contains the activity number'

export type ParsedPostId =
	/** A native LinkedIn activity number: it has to be resolved through a Get a Post call first. */
	| { kind: 'activity'; activityId: string }
	/** Any other string: the id list_user_posts returned, sent to Unipile exactly as given. */
	| { kind: 'opaque'; id: string }

function invalid(message: string): LinkedInIntegrationError {
	return new LinkedInIntegrationError('INVALID_INPUT', message)
}

function decoded(value: string): string {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

/**
 * Sorts a caller-supplied post id into an activity number or an opaque id.
 * Only a bare number, an urn:li:activity URN or a linkedin.com URL are
 * rewritten; everything else is left alone, since the opaque id list_user_posts
 * returns already works and must keep working unchanged. A URL or URN with no
 * activity number in it is rejected here, with the accepted forms named.
 */
export function parsePostId(raw: string): ParsedPostId {
	const value = raw.trim()
	if (/^\d+$/.test(value)) return { kind: 'activity', activityId: value }

	const urn = value.match(/^urn:li:activity:(\d+)$/i)
	if (urn) return { kind: 'activity', activityId: urn[1] as string }

	if (/^https?:\/\//i.test(value) || /^(www\.)?linkedin\.com\//i.test(value)) {
		// /posts/<handle>_<slug>-activity-<number>-<suffix> and
		// /feed/update/urn:li:activity:<number> (the colons may be percent-encoded).
		const path = decoded(value.split(/[?#]/)[0] ?? '')
		const hit = path.match(/urn:li:activity:(\d+)/i) ?? path.match(/activity-(\d+)/i)
		if (hit) return { kind: 'activity', activityId: hit[1] as string }
		throw invalid(
			`could not find an activity number in this URL. Accepted post_id forms: ${POST_ID_ACCEPTED_FORMS}`,
		)
	}

	if (/^urn:/i.test(value)) {
		throw invalid(`unsupported URN. Accepted post_id forms: ${POST_ID_ACCEPTED_FORMS}`)
	}

	return { kind: 'opaque', id: value }
}

/**
 * Adds the accepted forms to an upstream INVALID_INPUT so a caller whose id was
 * rejected by Unipile learns what to send instead. Other errors pass through.
 */
export function withAcceptedForms(err: unknown): unknown {
	if (err instanceof LinkedInIntegrationError && err.code === 'INVALID_INPUT') {
		return new LinkedInIntegrationError(
			'INVALID_INPUT',
			`${err.message}. Accepted post_id forms: ${POST_ID_ACCEPTED_FORMS}`,
			{ httpStatus: err.httpStatus, retryable: err.retryable, cause: err },
		)
	}
	return err
}

/** Shown on the post_id input of read_post_comments and get_post_engagement. */
export const POST_ID_DESCRIPTION = `Post to read. Accepts ${POST_ID_ACCEPTED_FORMS}.`
