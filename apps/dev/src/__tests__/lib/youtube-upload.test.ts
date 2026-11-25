import { Readable } from 'node:stream'
import { vi } from 'vitest'
import {
	UPLOAD_CHUNK_BYTES,
	buildInsertBody,
	publishVideo,
	startUploadSession,
	uploadFile,
} from '../../lib/youtube/google-upload-client'
import {
	YOUTUBE_UPLOAD_MAX_BYTES,
	YoutubeUploadRuleError,
	buildPublishPayload,
	buildUploadPayload,
	describeStoredRequest,
	parsePublishAt,
	publishTimeHasPassed,
} from '../../lib/youtube/upload'

const FILE = {
	id: '00000000-0000-4000-8000-000000000001',
	name: 'launch.mp4',
	mimeType: 'video/mp4',
	sizeBytes: 1_000,
	contentHash: 'abc',
}
const NOW = new Date('2026-12-01T08:00:00Z')

function ruleOf(fn: () => unknown): string | undefined {
	try {
		fn()
	} catch (err) {
		return err instanceof YoutubeUploadRuleError ? err.rule : 'other'
	}
	return undefined
}

describe('buildUploadPayload', () => {
	it('is always private and carries the synthetic media flag only when marked', () => {
		const plain = buildUploadPayload(FILE, { title: ' Launch ' })
		expect(plain).toMatchObject({ title: 'Launch', privacyStatus: 'private', fileId: FILE.id })
		expect(plain).not.toHaveProperty('containsSyntheticMedia')
		expect(buildUploadPayload(FILE, { title: 'Launch', aiGenerated: true })).toMatchObject({
			containsSyntheticMedia: true,
		})
	})

	it('refuses a file that is not a video, is empty or is over the limit', () => {
		expect(
			ruleOf(() => buildUploadPayload({ ...FILE, mimeType: 'image/png' }, { title: 'T' })),
		).toBe('not_a_video')
		expect(ruleOf(() => buildUploadPayload({ ...FILE, sizeBytes: 0 }, { title: 'T' }))).toBe(
			'file_empty',
		)
		const tooBig = { ...FILE, sizeBytes: YOUTUBE_UPLOAD_MAX_BYTES + 1 }
		expect(ruleOf(() => buildUploadPayload(tooBig, { title: 'T' }))).toBe('file_too_large')
		expect(() => buildUploadPayload(tooBig, { title: 'T' })).toThrow(/at most 256000000000 bytes/)
		expect(
			ruleOf(() =>
				buildUploadPayload({ ...FILE, sizeBytes: YOUTUBE_UPLOAD_MAX_BYTES }, { title: 'T' }),
			),
		).toBeUndefined()
	})

	it('refuses a bad title, description, tags or category', () => {
		expect(ruleOf(() => buildUploadPayload(FILE, { title: '   ' }))).toBe('bad_title')
		expect(ruleOf(() => buildUploadPayload(FILE, { title: 'a'.repeat(101) }))).toBe('bad_title')
		expect(ruleOf(() => buildUploadPayload(FILE, { title: 'x <b>' }))).toBe('bad_title')
		expect(
			ruleOf(() => buildUploadPayload(FILE, { title: 'T', description: 'é'.repeat(2_600) })),
		).toBe('bad_description')
		expect(ruleOf(() => buildUploadPayload(FILE, { title: 'T', tags: ['a'.repeat(501)] }))).toBe(
			'bad_tags',
		)
		expect(ruleOf(() => buildUploadPayload(FILE, { title: 'T', categoryId: 'music' }))).toBe(
			'bad_category',
		)
	})

	it('shows what the person is approving, read from the stored request', () => {
		const payload = buildUploadPayload(FILE, { title: 'T', aiGenerated: true })
		const lines = describeStoredRequest(
			'upload_video',
			payload as unknown as Record<string, unknown>,
		)
		expect(lines.join('\n')).toContain('PRIVATE')
		expect(lines.join('\n')).toContain('yes, marked by the requester')
		expect(lines.join('\n')).toContain('launch.mp4')
	})
})

describe('publish requests', () => {
	it('makes a scheduled video a private video with an exact UTC time', () => {
		const payload = buildPublishPayload(
			{ videoId: 'abcDEF12345', visibility: 'public', publishAt: '2026-12-01T12:00:00+02:00' },
			NOW,
		)
		expect(payload).toEqual({
			videoId: 'abcDEF12345',
			privacyStatus: 'private',
			publishAt: '2026-12-01T10:00:00.000Z',
		})
		expect(
			describeStoredRequest('publish_video', payload as unknown as Record<string, unknown>),
		).toEqual(['Goes public at exactly: 2026-12-01T10:00:00.000Z (UTC)'])
	})

	it('refuses a time that is not in the future, because YouTube would publish at once', () => {
		expect(ruleOf(() => parsePublishAt('2026-12-01T08:00:00Z', NOW))).toBe('publish_time_passed')
		expect(ruleOf(() => parsePublishAt('2026-11-30T08:00:00Z', NOW))).toBe('publish_time_passed')
		expect(
			ruleOf(() =>
				buildPublishPayload(
					{ videoId: 'abcDEF12345', visibility: 'public', publishAt: '2020-01-01T00:00:00Z' },
					NOW,
				),
			),
		).toBe('publish_time_passed')
	})

	it('refuses a time with no zone, a made-up time, and unlisted with a schedule', () => {
		expect(ruleOf(() => parsePublishAt('2026-12-02T10:00:00', NOW))).toBe('bad_publish_time')
		expect(ruleOf(() => parsePublishAt('tomorrow', NOW))).toBe('bad_publish_time')
		expect(
			ruleOf(() =>
				buildPublishPayload(
					{ videoId: 'abcDEF12345', visibility: 'unlisted', publishAt: '2026-12-02T10:00:00Z' },
					NOW,
				),
			),
		).toBe('bad_visibility')
		expect(
			ruleOf(() => buildPublishPayload({ videoId: 'no spaces', visibility: 'public' }, NOW)),
		).toBe('bad_video_id')
	})

	it('notices at the run that an approved time has gone by', () => {
		const payload = buildPublishPayload(
			{ videoId: 'abcDEF12345', visibility: 'public', publishAt: '2026-12-01T10:00:00Z' },
			NOW,
		)
		expect(publishTimeHasPassed(payload, new Date('2026-12-01T09:59:59Z'))).toBe(false)
		expect(publishTimeHasPassed(payload, new Date('2026-12-01T10:00:01Z'))).toBe(true)
		expect(publishTimeHasPassed({ videoId: 'abcDEF12345', privacyStatus: 'public' }, NOW)).toBe(
			false,
		)
	})
})

describe('the upload client', () => {
	const fetchMock = vi.fn()
	beforeEach(() => {
		fetchMock.mockReset()
		vi.stubGlobal('fetch', fetchMock)
	})
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	const payload = buildUploadPayload(FILE, { title: 'T', tags: ['a'] })

	it('writes private into the insert body whatever the request held', () => {
		const body = buildInsertBody({ ...payload, privacyStatus: 'public' } as never)
		expect(body.status).toEqual({ privacyStatus: 'private' })
		expect(buildInsertBody({ ...payload, containsSyntheticMedia: true }).status).toEqual({
			privacyStatus: 'private',
			containsSyntheticMedia: true,
		})
	})

	it('fails an insert whose status is unset or not private, without calling Google', async () => {
		for (const body of [
			{ snippet: { title: 'T' } },
			{ snippet: { title: 'T' }, status: {} },
			{ snippet: { title: 'T' }, status: { privacyStatus: 'public' } },
			{ snippet: { title: 'T' }, status: { privacyStatus: 'unlisted' } },
		]) {
			const result = await startUploadSession({
				accessToken: 't',
				body,
				sizeBytes: 10,
				mimeType: 'video/mp4',
			})
			expect(result).toEqual({ ok: false, code: 'privacy_not_private', retryable: false })
		}
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('opens the session with the private body and returns the session address', async () => {
		fetchMock.mockResolvedValue(
			new Response(null, { status: 200, headers: { location: 'https://upload.example/s1' } }),
		)
		const result = await startUploadSession({
			accessToken: 't',
			body: buildInsertBody(payload),
			sizeBytes: 1_000,
			mimeType: 'video/mp4',
		})
		expect(result).toEqual({ ok: true, sessionUri: 'https://upload.example/s1' })
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toContain('uploadType=resumable')
		expect(JSON.parse(init.body as string).status.privacyStatus).toBe('private')
		expect((init.headers as Record<string, string>)['X-Upload-Content-Length']).toBe('1000')
	})

	/** A file of `size` bytes read as a stream, one 1 MiB piece at a time, so it is never whole in memory. */
	const stream = (size: number) => {
		let sent = 0
		return new Readable({
			read() {
				const piece = Math.min(1_048_576, size - sent)
				if (piece <= 0) {
					this.push(null)
					return
				}
				sent += piece
				this.push(Buffer.alloc(piece, 1))
			},
		})
	}

	const TOTAL = UPLOAD_CHUNK_BYTES * 2 + 1_000
	const base = {
		sessionUri: 'https://upload.example/s1',
		getAccessToken: async () => 't',
		totalBytes: TOTAL,
		openFile: async () => stream(TOTAL),
	}
	const status = (next: number) =>
		new Response(null, {
			status: 308,
			headers: next > 0 ? { range: `bytes=0-${next - 1}` } : {},
		})

	it('streams the file in chunks, reports progress and returns the video id', async () => {
		fetchMock
			.mockResolvedValueOnce(status(0)) // where are we
			.mockResolvedValueOnce(status(UPLOAD_CHUNK_BYTES))
			.mockResolvedValueOnce(status(UPLOAD_CHUNK_BYTES * 2))
			.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'vid1' }), { status: 200 }))
		const progress: number[] = []
		const result = await uploadFile({ ...base, onProgress: async (n) => void progress.push(n) })
		expect(result).toEqual({ state: 'done', videoId: 'vid1' })
		expect(progress).toEqual([0, UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES * 2])
		const ranges = fetchMock.mock.calls
			.slice(1)
			.map(([, init]) => (init.headers as Record<string, string>)['Content-Range'])
		expect(ranges).toEqual([
			`bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${TOTAL}`,
			`bytes ${UPLOAD_CHUNK_BYTES}-${UPLOAD_CHUNK_BYTES * 2 - 1}/${TOTAL}`,
			`bytes ${UPLOAD_CHUNK_BYTES * 2}-${TOTAL - 1}/${TOTAL}`,
		])
		for (const [, init] of fetchMock.mock.calls.slice(1)) {
			expect((init.body as Uint8Array).length).toBeLessThanOrEqual(UPLOAD_CHUNK_BYTES)
		}
	})

	it('resumes from what Google holds, not from the start', async () => {
		fetchMock
			.mockResolvedValueOnce(status(UPLOAD_CHUNK_BYTES)) // Google already has the first chunk
			.mockResolvedValueOnce(status(UPLOAD_CHUNK_BYTES * 2))
			.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'vid1' }), { status: 201 }))
		const result = await uploadFile({ ...base, onProgress: async () => undefined })
		expect(result).toEqual({ state: 'done', videoId: 'vid1' })
		const first = (fetchMock.mock.calls[1] as [string, RequestInit])[1]
		expect((first.headers as Record<string, string>)['Content-Range']).toBe(
			`bytes ${UPLOAD_CHUNK_BYTES}-${UPLOAD_CHUNK_BYTES * 2 - 1}/${TOTAL}`,
		)
	})

	it('after a dropped chunk asks where Google is and sends only the rest', async () => {
		const half = UPLOAD_CHUNK_BYTES / 2
		fetchMock
			.mockResolvedValueOnce(status(0))
			.mockResolvedValueOnce(new Response(null, { status: 503 })) // chunk 1 fails
			.mockResolvedValueOnce(status(half)) // Google kept half of it
			.mockResolvedValueOnce(status(UPLOAD_CHUNK_BYTES)) // the rest arrives
			.mockResolvedValueOnce(status(UPLOAD_CHUNK_BYTES * 2))
			.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'vid1' }), { status: 200 }))
		const result = await uploadFile({ ...base, onProgress: async () => undefined })
		expect(result).toEqual({ state: 'done', videoId: 'vid1' })
		const retry = (fetchMock.mock.calls[3] as [string, RequestInit])[1]
		expect((retry.headers as Record<string, string>)['Content-Range']).toBe(
			`bytes ${half}-${UPLOAD_CHUNK_BYTES - 1}/${TOTAL}`,
		)
		expect((retry.body as Uint8Array).length).toBe(UPLOAD_CHUNK_BYTES - half)
	})

	it('reports an interruption, so the stored progress can be resumed later', async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 503 }))
		const result = await uploadFile({ ...base, onProgress: async () => undefined })
		expect(result).toEqual({ state: 'interrupted' })
	})

	it('stops on an error a retry cannot fix and on an expired session', async () => {
		fetchMock
			.mockResolvedValueOnce(status(0))
			.mockResolvedValueOnce(new Response(null, { status: 400 }))
		expect(await uploadFile({ ...base, onProgress: async () => undefined })).toEqual({
			state: 'failed',
			code: 'http_400',
		})
		fetchMock.mockReset()
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
		expect(await uploadFile({ ...base, onProgress: async () => undefined })).toEqual({
			state: 'failed',
			code: 'session_expired',
		})
	})

	describe('publishVideo', () => {
		const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

		it('carries the current settings over and changes only privacy and the time', async () => {
			fetchMock
				.mockResolvedValueOnce(
					json({
						items: [
							{
								status: {
									privacyStatus: 'private',
									uploadStatus: 'processed',
									embeddable: true,
									containsSyntheticMedia: true,
									madeForKids: false,
								},
							},
						],
					}),
				)
				.mockResolvedValueOnce(json({}))
			const result = await publishVideo({
				accessToken: 't',
				payload: {
					videoId: 'abcDEF12345',
					privacyStatus: 'private',
					publishAt: '2026-12-01T10:00:00.000Z',
				},
			})
			expect(result).toEqual({ ok: true })
			const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit]
			expect(url).toBe('https://www.googleapis.com/youtube/v3/videos?part=status')
			expect(init.method).toBe('PUT')
			expect(JSON.parse(init.body as string)).toEqual({
				id: 'abcDEF12345',
				status: {
					privacyStatus: 'private',
					embeddable: true,
					containsSyntheticMedia: true,
					publishAt: '2026-12-01T10:00:00.000Z',
				},
			})
		})

		it('refuses to schedule a video that is not private, and to repeat a change', async () => {
			fetchMock.mockResolvedValueOnce(json({ items: [{ status: { privacyStatus: 'unlisted' } }] }))
			expect(
				await publishVideo({
					accessToken: 't',
					payload: {
						videoId: 'abcDEF12345',
						privacyStatus: 'private',
						publishAt: '2026-12-01T10:00:00.000Z',
					},
				}),
			).toEqual({ ok: false, code: 'not_private' })
			fetchMock.mockResolvedValueOnce(json({ items: [{ status: { privacyStatus: 'public' } }] }))
			expect(
				await publishVideo({
					accessToken: 't',
					payload: { videoId: 'abcDEF12345', privacyStatus: 'public' },
				}),
			).toEqual({ ok: false, code: 'already_set' })
			expect(fetchMock).toHaveBeenCalledTimes(2)
		})

		it('returns a code for a missing video and for a Google error', async () => {
			fetchMock.mockResolvedValueOnce(json({ items: [] }))
			expect(
				await publishVideo({
					accessToken: 't',
					payload: { videoId: 'abcDEF12345', privacyStatus: 'public' },
				}),
			).toEqual({ ok: false, code: 'video_not_found' })
			fetchMock.mockResolvedValueOnce(json({}, 403))
			expect(
				await publishVideo({
					accessToken: 't',
					payload: { videoId: 'abcDEF12345', privacyStatus: 'public' },
				}),
			).toEqual({ ok: false, code: 'http_403' })
		})
	})
})
