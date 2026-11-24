import { YoutubeError } from './errors'

/**
 * What channels.list can look a channel up by. Exactly one key is set.
 *  - id: a channel id (UC plus 22 characters)
 *  - forHandle: a handle, with the leading @
 *  - forUsername: a legacy username from a /user/ URL
 */
export type ChannelLookup = { id: string } | { forHandle: string } | { forUsername: string }

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/
const HANDLE = /^@[A-Za-z0-9._-]{3,30}$/
const USERNAME = /^[A-Za-z0-9]{1,40}$/
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com'])

function invalid(message: string): YoutubeError {
	return new YoutubeError({
		code: 'INVALID_INPUT',
		message,
		hint: 'Pass a channel id (UC and 22 characters), a handle such as @name, or a youtube.com channel URL.',
	})
}

/**
 * Turn what an agent passes (a channel id, a handle or a channel URL) into one channels.list lookup.
 * Custom /c/ URLs and bare names cannot be resolved by channels.list, and a search would cost the
 * search bucket, so those are refused with a hint instead of guessed.
 */
export function parseChannelRef(input: string): ChannelLookup {
	const raw = input.trim()
	if (CHANNEL_ID.test(raw)) return { id: raw }
	if (HANDLE.test(raw)) return { forHandle: raw }

	let url: URL
	try {
		url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
	} catch {
		throw invalid('That is not a channel id, a handle or a YouTube channel URL.')
	}
	if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) {
		throw invalid('That is not a youtube.com URL.')
	}

	const [first, second] = url.pathname.split('/').filter(Boolean)
	if (first?.startsWith('@')) {
		const handle = decodeURIComponent(first)
		if (HANDLE.test(handle)) return { forHandle: handle }
	}
	if (first === 'channel' && second && CHANNEL_ID.test(second)) return { id: second }
	if (first === 'user' && second && USERNAME.test(second)) return { forUsername: second }
	throw invalid('That URL does not name a channel by id, handle or username.')
}
