/**
 * Mock handlers for the LinkedIn v2 warm-up surface: list a user's posts, get a
 * company profile, add a reaction.
 *
 * Wire shapes follow the v2 reference pages (read 2026-10-22). The post rows use
 * Unipile's own post ids, and the reaction route refuses a native activity id the
 * way the live API does for ids it cannot resolve, so a regression that forwards
 * the wrong id fails the suite instead of passing green.
 */

/** Unipile post ids the posts list hands back; `tryHandlePostsReads` accepts these. */
export const POSTS_READS_FIRST_POST_ID = 'mock-post-1'
export const POSTS_READS_SECOND_POST_ID = 'mock-post-2'
export const POSTS_READS_AUTHOR_ID = 'ACoAAAmockauthor1'

export const CANNED_USER_POSTS_RESPONSE = (authorId: string, cursor: string | null) => {
	// A numeric id is a company page, the way the live API labels the author.
	const isCompany = /^\d+$/.test(authorId)
	const author = {
		object: 'User',
		id: authorId,
		type: isCompany ? 'organization' : 'individual',
		public_identifier: isCompany ? 'analytical-engines' : 'adalovelace',
		display_name: isCompany ? 'Analytical Engines Ltd' : 'Ada Lovelace',
	}
	if (cursor === 'page-2') {
		return { object: 'PostList', data: [], next_cursor: null }
	}
	return {
		object: 'PostList',
		data: [
			{
				object: 'Post',
				id: POSTS_READS_FIRST_POST_ID,
				share_url: 'https://www.linkedin.com/posts/adalovelace_mock-1',
				created_at: '2026-10-20T08:00:00.000Z',
				text: 'a'.repeat(700),
				user_reacted: false,
				reactions_counter: [
					{ type: 'linkedin_like', count: 10 },
					{ type: 'linkedin_celebrate', count: 2 },
				],
				comments_counter: 3,
				reposts_counter: 1,
				is_repost: false,
				author,
			},
			{
				object: 'Post',
				id: POSTS_READS_SECOND_POST_ID,
				share_url: 'https://www.linkedin.com/posts/adalovelace_mock-2',
				created_at: '2026-10-18T08:00:00.000Z',
				text: 'A reshared post',
				user_reacted: 'linkedin_like',
				reactions_counter: null,
				comments_counter: null,
				is_repost: true,
				author: { ...author, id: 'ACoAAAoriginal', display_name: 'Someone Else' },
			},
		],
		next_cursor: 'page-2',
	}
}

export const CANNED_COMPANY_PROFILE_RESPONSE = () => ({
	object: 'CompanyProfile',
	id: '1234567',
	name: 'Analytical Engines Ltd',
	public_identifier: 'analytical-engines',
	profile_url: 'https://www.linkedin.com/company/analytical-engines',
	description: 'd'.repeat(700),
	website: 'https://analytical.example',
	followers_count: 4200,
	industry: ['Computer Software', 'Mechanical Engineering'],
	locations: [
		{ is_headquarter: false, city: 'Paris', country_code: 'FR' },
		{ is_headquarter: true, city: 'London', area: 'England', country_code: 'GB' },
	],
	insights: { headcount: 87, headcount_range: { from: 51, to: 200 } },
})

export const CANNED_POST_REACTION_ADDED_RESPONSE = () => ({ object: 'PostReactionAdded' })

const NATIVE_POST_ID = /^(urn:|activity[:-]|ugcPost[:-]|share[:-])/

export type PostsReadsResult = { status: number; body: unknown }

/**
 * Dispatch a request against the warm-up surface. Returns `null` for any other
 * (method, path) so the caller can chain further handlers.
 */
export function tryHandlePostsReads(method: string, path: string): PostsReadsResult | null {
	if (method === 'GET') {
		const posts = path.match(/^\/v2\/[^/]+\/users\/([^/?]+)\/posts(?:\?(.*))?$/)
		if (posts) {
			const cursor = new URLSearchParams(posts[2] ?? '').get('cursor')
			return {
				status: 200,
				body: CANNED_USER_POSTS_RESPONSE(decodeURIComponent(posts[1] as string), cursor),
			}
		}
		if (/^\/v2\/[^/]+\/linkedin\/company\/[^/?]+$/.test(path)) {
			return { status: 200, body: CANNED_COMPANY_PROFILE_RESPONSE() }
		}
		return null
	}
	if (method === 'POST') {
		const reaction = path.match(/^\/v2\/[^/]+\/posts\/([^/?]+)\/reactions$/)
		if (!reaction) return null
		if (NATIVE_POST_ID.test(decodeURIComponent(reaction[1] as string))) {
			return {
				status: 400,
				body: {
					object: 'Error',
					error_code: 'invalid_post_id',
					message: 'Invalid post id: use the id a Get a Post or List Posts response carries.',
				},
			}
		}
		return { status: 200, body: CANNED_POST_REACTION_ADDED_RESPONSE() }
	}
	return null
}
