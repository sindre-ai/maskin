import type { YoutubeActionKind } from './actions'

/**
 * The only code that sends a write to Google. Import it from `executor.ts` and nowhere else: a
 * test fails if any other module does, so no tool can reach YouTube without an approved action.
 *
 * The result carries a category and a code, never Google's error text (which can quote the
 * request, and so a comment or a title).
 */

const API = 'https://www.googleapis.com/youtube/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3'
const REQUEST_TIMEOUT_MS = 30_000
const VIDEO_PARTS = ['snippet', 'status', 'localizations']

export interface YoutubeWriteRequest {
	kind: YoutubeActionKind
	/** The exact request stored with the approved action. */
	payload: Record<string, unknown>
	accessToken: string
	/** The image for set_thumbnail, read and checked by the executor. */
	image?: { bytes: Uint8Array; mimeType: string }
}

export interface YoutubeWriteResult {
	ok: boolean
	/** 'ok', 'http_<status>', 'unsupported_kind' or 'bad_payload'. */
	code: string
}

interface PlannedRequest {
	method: 'POST' | 'PUT'
	path: string
	query: Record<string, string>
	body?: Record<string, unknown>
}

function plan(kind: YoutubeActionKind, payload: Record<string, unknown>): PlannedRequest | null {
	switch (kind) {
		case 'update_video_metadata': {
			const part = Object.keys(payload).filter((key) => VIDEO_PARTS.includes(key))
			if (typeof payload.id !== 'string' || part.length === 0) return null
			return { method: 'PUT', path: '/videos', query: { part: part.join(',') }, body: payload }
		}
		case 'create_playlist':
			return {
				method: 'POST',
				path: '/playlists',
				query: { part: 'snippet,status' },
				body: payload,
			}
		case 'add_to_playlist':
			return { method: 'POST', path: '/playlistItems', query: { part: 'snippet' }, body: payload }
		case 'post_comment':
			return { method: 'POST', path: '/commentThreads', query: { part: 'snippet' }, body: payload }
		case 'reply_to_comment':
			return { method: 'POST', path: '/comments', query: { part: 'snippet' }, body: payload }
		case 'like': {
			if (typeof payload.id !== 'string') return null
			const rating = payload.rating === 'none' ? 'none' : 'like'
			return { method: 'POST', path: '/videos/rate', query: { id: payload.id, rating } }
		}
		default:
			// set_thumbnail uploads an image, which needs its own request shape (see execute).
			return null
	}
}

async function setThumbnail(request: YoutubeWriteRequest): Promise<YoutubeWriteResult> {
	const { videoId } = request.payload
	if (typeof videoId !== 'string' || !request.image) return { ok: false, code: 'bad_payload' }
	const query = new URLSearchParams({ videoId, uploadType: 'media' }).toString()
	const response = await fetch(`${UPLOAD_API}/thumbnails/set?${query}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${request.accessToken}`,
			'Content-Type': request.image.mimeType,
		},
		body: request.image.bytes as BodyInit,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	})
	return response.ok ? { ok: true, code: 'ok' } : { ok: false, code: `http_${response.status}` }
}

export const googleWriteClient = {
	async execute(request: YoutubeWriteRequest): Promise<YoutubeWriteResult> {
		if (request.kind === 'set_thumbnail') return setThumbnail(request)
		const planned = plan(request.kind, request.payload)
		if (!planned) return { ok: false, code: 'bad_payload' }
		const url = `${API}${planned.path}?${new URLSearchParams(planned.query).toString()}`
		const response = await fetch(url, {
			method: planned.method,
			headers: {
				Authorization: `Bearer ${request.accessToken}`,
				...(planned.body ? { 'Content-Type': 'application/json' } : {}),
			},
			...(planned.body ? { body: JSON.stringify(planned.body) } : {}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
		return response.ok ? { ok: true, code: 'ok' } : { ok: false, code: `http_${response.status}` }
	},
}

export type YoutubeWriteClient = typeof googleWriteClient
