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

	it.each([
		['delete_video', 'videos', { id: 'v1', title: 'Launch day' }, 'v1'],
		['delete_comment', 'comments', { id: 'c1', author: 'Ann', text: 'Hi' }, 'c1'],
		['delete_playlist', 'playlists', { id: 'PL1', title: 'Best of' }, 'PL1'],
		[
			'remove_from_playlist',
			'playlistItems',
			{ id: 'item1', playlistId: 'PL1', playlistTitle: 'Best of', videoId: 'v1', videoTitle: 'T' },
			'item1',
		],
	] as const)('%s sends a DELETE with only the id and no body', async (kind, path, payload, id) => {
		fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
		expect(await run(kind, payload)).toEqual({ ok: true, code: 'ok' })
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe(`https://www.googleapis.com/youtube/v3/${path}?id=${id}`)
		expect(init.method).toBe('DELETE')
		expect(init.body).toBeUndefined()
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t0k')
	})

	it('does not call Google for a delete with no id', async () => {
		expect(await run('delete_video', { title: 'No id' })).toEqual({
			ok: false,
			code: 'bad_payload',
		})
		expect(await run('delete_comment', { id: '' })).toEqual({ ok: false, code: 'bad_payload' })
		expect(fetchMock).not.toHaveBeenCalled()
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

	describe('captions', () => {
		const SRT = Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nHello\n')
		const sendCaption = (kind: 'upload_caption' | 'replace_caption', payload: object) =>
			googleWriteClient.execute({
				kind,
				payload: payload as Record<string, unknown>,
				accessToken: 't0k',
				caption: { bytes: SRT },
			})
		const bodyOf = (init: RequestInit) => (init.body as Buffer).toString('utf8')

		it('uploads a caption as metadata plus the file in one multipart request', async () => {
			fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
			const result = await sendCaption('upload_caption', {
				videoId: 'v',
				language: 'en',
				name: 'English',
				isDraft: false,
			})
			expect(result).toEqual({ ok: true, code: 'ok' })
			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
			expect(url).toBe(
				'https://www.googleapis.com/upload/youtube/v3/captions?part=snippet&uploadType=multipart',
			)
			expect(init.method).toBe('POST')
			const headers = init.headers as Record<string, string>
			expect(headers.Authorization).toBe('Bearer t0k')
			expect(headers['Content-Type']).toMatch(/^multipart\/related; boundary=maskin-/)
			const body = bodyOf(init)
			expect(body).toContain(
				JSON.stringify({
					snippet: { videoId: 'v', language: 'en', name: 'English', isDraft: false },
				}),
			)
			expect(body).toContain(SRT.toString('utf8'))
		})

		it('replaces a caption track by id with a PUT and keeps the track as it is', async () => {
			fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
			await sendCaption('replace_caption', {
				videoId: 'v',
				captionId: 'cap1',
				language: 'en',
				name: 'English',
				isDraft: true,
			})
			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
			expect(url).toContain('/upload/youtube/v3/captions?part=snippet')
			expect(init.method).toBe('PUT')
			expect(bodyOf(init)).toContain(JSON.stringify({ id: 'cap1', snippet: { isDraft: true } }))
		})

		it('deletes a caption track by id with no body', async () => {
			fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
			expect(await run('delete_caption', { videoId: 'v', captionId: 'cap1' })).toEqual({
				ok: true,
				code: 'ok',
			})
			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
			expect(url).toBe('https://www.googleapis.com/youtube/v3/captions?id=cap1')
			expect(init.method).toBe('DELETE')
			expect(init.body).toBeUndefined()
		})

		it('does not call Google for a caption with no file, or a replace or delete with no track id', async () => {
			expect(await run('upload_caption', { videoId: 'v', language: 'en' })).toEqual({
				ok: false,
				code: 'bad_payload',
			})
			expect(await sendCaption('replace_caption', { videoId: 'v', language: 'en' })).toEqual({
				ok: false,
				code: 'bad_payload',
			})
			expect(await run('delete_caption', { videoId: 'v' })).toEqual({
				ok: false,
				code: 'bad_payload',
			})
			expect(fetchMock).not.toHaveBeenCalled()
		})
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
