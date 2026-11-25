import { type YoutubeClientContext, youtubeRead } from './client'

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
