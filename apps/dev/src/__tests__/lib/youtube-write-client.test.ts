import { vi } from 'vitest'
import { googleWriteClient } from '../../lib/youtube/google-write-client'

describe('googleWriteClient', () => {
	const fetchMock = vi.fn()

	beforeEach(() => {
		fetchMock.mockReset()
		vi.stubGlobal('fetch', fetchMock)
	})
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	const run = (kind: Parameters<typeof googleWriteClient.execute>[0]['kind'], payload: object) =>
		googleWriteClient.execute({
			kind,
			payload: payload as Record<string, unknown>,
			accessToken: 't0k',
		})

	it('sends a comment as a thread with the token and the stored body', async () => {
		fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
		const body = { snippet: { videoId: 'v', topLevelComment: { snippet: { textOriginal: 'Hi' } } } }
		expect(await run('post_comment', body)).toEqual({ ok: true, code: 'ok' })
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://www.googleapis.com/youtube/v3/commentThreads?part=snippet')
		expect(init.method).toBe('POST')
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t0k')
		expect(JSON.parse(init.body as string)).toEqual(body)
	})

	it('updates a video with the parts the request carries', async () => {
		fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
		await run('update_video_metadata', {
			id: 'v',
			snippet: { title: 'T' },
			status: { privacyStatus: 'private' },
		})
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://www.googleapis.com/youtube/v3/videos?part=snippet%2Cstatus')
		expect(init.method).toBe('PUT')
	})

	it('rates a video with no body', async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
		await run('like', { id: 'v' })
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://www.googleapis.com/youtube/v3/videos/rate?id=v&rating=like')
		expect(init.body).toBeUndefined()
	})

	it('returns a code and never the text Google sent back', async () => {
		fetchMock.mockResolvedValue(new Response('{"error":"quotes your comment"}', { status: 403 }))
		const result = await run('create_playlist', { snippet: { title: 'P' } })
		expect(result).toEqual({ ok: false, code: 'http_403' })
	})

	it('uploads a thumbnail as the image bytes with the image type', async () => {
		fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
		const result = await googleWriteClient.execute({
			kind: 'set_thumbnail',
			payload: { videoId: 'v' },
			accessToken: 't0k',
			image: { bytes, mimeType: 'image/png' },
		})
		expect(result).toEqual({ ok: true, code: 'ok' })
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe(
			'https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=v&uploadType=media',
		)
		expect(init.method).toBe('POST')
		expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/png')
		expect(init.body).toBe(bytes)
	})

	it('does not call Google for a thumbnail with no image or a request with no target', async () => {
		expect(await run('set_thumbnail', { videoId: 'v' })).toEqual({
			ok: false,
			code: 'bad_payload',
		})
		expect(await run('update_video_metadata', { snippet: {} })).toEqual({
			ok: false,
			code: 'bad_payload',
		})
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
