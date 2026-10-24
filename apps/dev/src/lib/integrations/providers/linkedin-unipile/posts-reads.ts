import type { LinkedInHttpCall, LinkedInHttpResult } from './unipile-client'
import { normalizeProfileIdentifier } from './unipile-client'

/**
 * Unipile v2 client methods for the warm-up tools: read a person's or a
 * company's recent posts, look up a company, and like one post. Shapes are from
 * the v2 reference pages "List all posts of a user", "Get a company profile"
 * and "Add a reaction to a post" (read 2026-10-22).
 *
 * These sit beside `LinkedInClient` rather than on it, so the existing fakes of
 * that interface (and the sibling tasks adding their own methods) stay
 * untouched. They share the same fetch wrapper (`createLinkedInHttpCall`).
 */

export type LinkedInListUserPostsQuery = {
	account_id: string
	/** Provider id of a person or a company. */
	user_id: string
	cursor?: string
	limit?: number
}

export type LinkedInGetCompanyProfileQuery = {
	account_id: string
	/** Numeric company id or the public identifier (slug). */
	company_id: string
}

/** Like is the only reaction this surface sends; no `react_as` (personal only). */
export type LinkedInAddPostReactionPayload = {
	account_id: string
	/** The Unipile post id, exactly as `listUserPosts` returned it. */
	post_id: string
}

export interface PostsReadsClient {
	listUserPosts(
		query: LinkedInListUserPostsQuery,
	): Promise<LinkedInHttpResult<Record<string, unknown>>>
	getCompanyProfile(
		query: LinkedInGetCompanyProfileQuery,
	): Promise<LinkedInHttpResult<Record<string, unknown>>>
	addPostReaction(
		payload: LinkedInAddPostReactionPayload,
	): Promise<LinkedInHttpResult<Record<string, unknown>>>
}

export const LINKEDIN_LIKE_REACTION = 'linkedin_like'

export function createPostsReadsClient(call: LinkedInHttpCall): PostsReadsClient {
	return {
		listUserPosts(query) {
			// GET /v2/{account_id}/users/{user_id}/posts?cursor=&limit=
			// Cursor-only pagination; `user_id` is the provider id of a person or
			// a company ("ID of the user or company").
			const params = new URLSearchParams()
			if (query.cursor) params.set('cursor', query.cursor)
			if (typeof query.limit === 'number') params.set('limit', String(query.limit))
			const qs = params.toString()
			const acc = encodeURIComponent(query.account_id)
			const user = encodeURIComponent(query.user_id)
			return call('GET', `/v2/${acc}/users/${user}/posts${qs ? `?${qs}` : ''}`)
		},
		getCompanyProfile(query) {
			// GET /v2/{account_id}/linkedin/company/{company_id}; accepts the
			// numeric id or the public identifier.
			const acc = encodeURIComponent(query.account_id)
			const company = encodeURIComponent(query.company_id)
			return call('GET', `/v2/${acc}/linkedin/company/${company}`)
		},
		addPostReaction(payload) {
			// POST /v2/{account_id}/posts/{post_id}/reactions { reaction }.
			// Unipile's own post id, unchanged: native activity ids are only
			// accepted on Get a Post.
			const acc = encodeURIComponent(payload.account_id)
			const post = encodeURIComponent(payload.post_id)
			return call('POST', `/v2/${acc}/posts/${post}/reactions`, {
				reaction: LINKEDIN_LIKE_REACTION,
			})
		},
	}
}

// ── Input normalisers ───────────────────────────────────────────────────

/** Provider ids of members look like ACoAAA…; those need no resolving call. */
export function isMemberProviderId(identifier: string): boolean {
	return /^ACo[A-Za-z0-9_-]+$/.test(identifier)
}

/** Same reduction `get_profile` applies (member URNs to the bare provider id). */
export function normalizePersonInput(raw: string): string {
	return normalizeProfileIdentifier(raw)
}

export type CompanyRef = { kind: 'id'; value: string } | { kind: 'slug'; value: string }

/**
 * A company as the caller wrote it: a numeric id, a slug, or a
 * linkedin.com/company/... URL reduced to its slug (or numeric id). Returns
 * null when nothing usable is left.
 */
export function normalizeCompanyInput(raw: string): CompanyRef | null {
	let value = raw.trim()
	const marker = /linkedin\.com\/company\//i.exec(value)
	if (marker) {
		const rest = value.slice(marker.index + marker[0].length)
		value = rest.split(/[/?#]/)[0] ?? ''
		try {
			value = decodeURIComponent(value)
		} catch {
			// Malformed escape: keep the raw segment.
		}
	}
	value = value.trim()
	if (!value) return null
	return /^\d+$/.test(value) ? { kind: 'id', value } : { kind: 'slug', value }
}

// ── Response mappers ────────────────────────────────────────────────────

const TEXT_LIMIT = 500

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null
}

function num(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export type PostAuthor = {
	provider_id: string
	type: string | null
	name: string | null
	public_identifier: string | null
}

export type PostSummary = {
	post_id: string
	posted_at: string | null
	text: string
	is_repost: boolean
	reactions: number | null
	comments: number | null
	already_liked: boolean
	url: string | null
}

/**
 * `reactions_counter` is an array of per-type counts (or null when LinkedIn
 * gave none). Sum entries that are numbers or carry a numeric `count`; null
 * when nothing could be read, so an unknown never looks like zero.
 */
function sumReactions(raw: unknown): number | null {
	if (!Array.isArray(raw)) return null
	let total = 0
	let seen = false
	for (const entry of raw) {
		const n = num(entry) ?? num(asRecord(entry)?.count) ?? num(asRecord(entry)?.value)
		if (n === null) continue
		total += n
		seen = true
	}
	return seen ? total : raw.length === 0 ? 0 : null
}

function toPostSummary(raw: unknown): PostSummary | null {
	const p = asRecord(raw)
	const id = str(p?.id)
	if (!p || !id) return null
	const text = typeof p.text === 'string' ? p.text : ''
	// `user_reacted` is a boolean, or the reaction type already given. Any
	// reaction counts: we never stack a second one on the same post.
	const reacted = p.user_reacted
	return {
		post_id: id,
		posted_at: str(p.created_at),
		text: text.slice(0, TEXT_LIMIT),
		is_repost: p.is_repost === true,
		reactions: sumReactions(p.reactions_counter),
		comments: num(p.comments_counter),
		already_liked: reacted === true || (typeof reacted === 'string' && reacted.length > 0),
		url: str(p.share_url),
	}
}

export type PostsPage = {
	posts: PostSummary[]
	next_cursor: string | null
	/** Author block of the first post written by `providerId`, when one is present. */
	author: Omit<PostAuthor, 'provider_id'> | null
}

/**
 * Map one `GET users/{id}/posts` page. Rows without an id are dropped (nothing
 * can be done with them). The author is read off a post whose author id is the
 * provider id we asked for; a repost row carries the original author, so it is
 * not used.
 */
export function toPostsPage(body: unknown, providerId: string): PostsPage {
	const rec = asRecord(body) ?? {}
	const rows = Array.isArray(rec.data) ? rec.data : []
	const posts: PostSummary[] = []
	let author: PostsPage['author'] = null
	for (const row of rows) {
		const post = toPostSummary(row)
		if (!post) continue
		posts.push(post)
		const a = asRecord(asRecord(row)?.author)
		if (!author && a && a.id === providerId) {
			author = {
				type: str(a.type),
				name: str(a.display_name),
				public_identifier: str(a.public_identifier),
			}
		}
	}
	return { posts, next_cursor: str(rec.next_cursor) ?? str(rec.cursor), author }
}

export type CompanySummary = {
	company_id: string
	name: string | null
	public_identifier: string | null
	industry: string | null
	size_band: string | null
	headcount: number | null
	headquarters: string | null
	website: string | null
	follower_count: number | null
	description: string | null
	url: string | null
}

function sizeBand(insights: Record<string, unknown> | null): string | null {
	const range = asRecord(insights?.headcount_range)
	const from = num(range?.from)
	const to = num(range?.to)
	if (from !== null && to !== null) return `${from}-${to}`
	if (from !== null) return `${from}+`
	return null
}

function locationText(raw: unknown): string | null {
	const l = asRecord(raw)
	if (!l) return null
	const parts = [str(l.city), str(l.area), str(l.country_code)].filter(Boolean)
	return parts.length > 0 ? parts.join(', ') : str(l.description)
}

/** Map a `CompanyProfile`. Null when the body carries no company id. */
export function toCompanySummary(body: unknown): CompanySummary | null {
	const c = asRecord(body)
	const id = str(c?.id)
	if (!c || !id) return null
	const industry = Array.isArray(c.industry) ? str(c.industry[0]) : str(c.industry)
	const locations = Array.isArray(c.locations) ? c.locations : []
	const hq = locations.find((l) => asRecord(l)?.is_headquarter === true) ?? locations[0]
	const insights = asRecord(c.insights)
	const description = str(c.description)
	return {
		company_id: id,
		name: str(c.name),
		public_identifier: str(c.public_identifier),
		industry,
		size_band: sizeBand(insights),
		headcount: num(insights?.headcount),
		headquarters: locationText(hq),
		website: str(c.website),
		follower_count: num(c.followers_count),
		description: description ? description.slice(0, TEXT_LIMIT) : null,
		url: str(c.profile_url),
	}
}
