import { type YoutubeClientContext, youtubeRead } from './client'
import { YoutubeError } from './errors'

export const COMMENTS_MAX_PER_PAGE = 100
export const COMMENTS_MAX_PAGES = 3

export interface ListCommentsInput {
	video_id: string
	order: 'time' | 'relevance'
	/** Threads per page, 1 to 100. */
	max_results: number
	/** Pages to read in this call, 1 to 3. Each page costs 1 unit. */
	pages: number
	/** Continue from the next_page_token of an earlier call. */
	page_token?: string
}

interface CommentThreadsPage {
	items?: unknown[]
	nextPageToken?: string
}

/**
 * commentThreads.list for one video, up to COMMENTS_MAX_PAGES pages a call, 1 unit a page. Threads
 * are returned as the API returns them. The comment text is never stored: it passes through the
 * 15 minute memory cache like any other read and is not written anywhere else.
 */
export async function listComments(client: YoutubeClientContext, input: ListCommentsInput) {
	const items: unknown[] = []
	let pageToken = input.page_token
	let pagesRead = 0
	while (pagesRead < Math.min(input.pages, COMMENTS_MAX_PAGES)) {
		const params: Record<string, string> = {
			part: 'snippet,replies',
			videoId: input.video_id,
			maxResults: String(Math.min(input.max_results, COMMENTS_MAX_PER_PAGE)),
			order: input.order,
			textFormat: 'plainText',
		}
		if (pageToken) params.pageToken = pageToken
		const page = await youtubeRead<CommentThreadsPage>(client, {
			tool: 'youtube__list_comments',
			path: 'commentThreads',
			params,
			units: 1,
		})
		pagesRead += 1
		items.push(...(page.items ?? []))
		pageToken = page.nextPageToken
		if (!pageToken) break
	}
	return { items, pages_read: pagesRead, next_page_token: pageToken ?? null }
}

export interface ListHeldCommentsInput {
	/** held_for_review is what the channel's settings held; likely_spam is what YouTube flagged. */
	status: 'held_for_review' | 'likely_spam'
	/** Threads on this page, 1 to 100. */
	max_results: number
	/** Continue from the next_page_token of an earlier call. */
	page_token?: string
}

const HELD_STATUS = { held_for_review: 'heldForReview', likely_spam: 'likelySpam' } as const

/**
 * commentThreads.list for the whole connected channel, limited to comments waiting for a decision.
 * One page a call, 1 unit. Never cached and never stored: the queue changes as comments are
 * decided, and comment text stays out of memory too.
 */
export async function listHeldComments(client: YoutubeClientContext, input: ListHeldCommentsInput) {
	// The same read as youtube__get_channel (same tool name and arguments), so it shares its cache.
	const channels = await youtubeRead<{ items?: Array<{ id?: string }> }>(client, {
		tool: 'youtube__get_channel',
		path: 'channels',
		params: { part: 'snippet,statistics,contentDetails', mine: 'true' },
		units: 1,
	})
	const channelId = channels.items?.[0]?.id
	if (!channelId) {
		throw new YoutubeError({
			code: 'PROVIDER_ERROR',
			message: 'The connected Google account has no YouTube channel.',
		})
	}
	const params: Record<string, string> = {
		part: 'snippet',
		allThreadsRelatedToChannelId: channelId,
		moderationStatus: HELD_STATUS[input.status],
		maxResults: String(Math.min(input.max_results, COMMENTS_MAX_PER_PAGE)),
		order: 'time',
		textFormat: 'plainText',
	}
	if (input.page_token) params.pageToken = input.page_token
	const page = await youtubeRead<CommentThreadsPage>(client, {
		tool: 'youtube__list_held_comments',
		path: 'commentThreads',
		params,
		units: 1,
		cache: false,
	})
	return { items: page.items ?? [], next_page_token: page.nextPageToken ?? null }
}
