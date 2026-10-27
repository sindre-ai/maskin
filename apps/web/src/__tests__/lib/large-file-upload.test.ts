import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		files: { startUpload: vi.fn(), completeUpload: vi.fn(), abortUpload: vi.fn() },
	},
}))

vi.mock('@/lib/file-utils', () => ({
	readFileAsBase64: vi.fn(async () => 'YmFzZTY0'),
}))

import { api } from '@/lib/api'
import { assertUploadable, toUploadInput, uploadLargeFile } from '@/lib/large-file-upload'

const MiB = 1024 * 1024

function fileOfSize(name: string, size: number, type = 'video/mp4') {
	const file = new File(['x'], name, { type })
	Object.defineProperty(file, 'size', { value: size })
	return file
}

// A storage stand-in: each PUT answers with an ETag naming its part's URL, or
// fails as `failUrl` says.
let puts: { url: string; bytes: number }[]
let failUrl: string | null
let hideEtag: boolean

class FakeXhr {
	upload: { onprogress?: (e: { loaded: number }) => void } = {}
	status = 0
	onload?: () => void
	onerror?: () => void
	onabort?: () => void
	private url = ''
	open(_method: string, url: string) {
		this.url = url
	}
	setRequestHeader() {}
	getResponseHeader(name: string) {
		return name === 'ETag' && !hideEtag ? `"etag-of-${this.url}"` : null
	}
	abort() {
		this.onabort?.()
	}
	send(blob: Blob) {
		queueMicrotask(() => {
			if (this.url === failUrl) {
				this.status = 500
			} else {
				this.status = 200
				puts.push({ url: this.url, bytes: blob.size })
				this.upload.onprogress?.({ loaded: blob.size })
			}
			this.onload?.()
		})
	}
}

const session = (parts: number) => ({
	upload_id: 'up-1',
	file_id: 'f-1',
	part_size: 16 * MiB,
	parts: Array.from({ length: parts }, (_, i) => ({
		part_number: i + 1,
		url: `https://storage.test/p${i + 1}`,
	})),
	expires_at: new Date().toISOString(),
})

describe('toUploadInput', () => {
	it('reads a small file as base64 for the JSON path', async () => {
		const input = await toUploadInput(fileOfSize('a.mp4', 10 * MiB))

		expect(input).toEqual({
			name: 'a.mp4',
			mime_type: 'video/mp4',
			content: 'YmFzZTY0',
			encoding: 'base64',
		})
	})

	it('hands a file over 50 MB through untouched, without reading it', async () => {
		const file = fileOfSize('big.mp4', 51 * MiB)

		const input = await toUploadInput(file)

		expect(input).toEqual({ file })
	})

	// The JSON route caps a non-video file at 10 MB, so anything above that must go
	// straight to storage; a 30 MB PDF used to be sent as JSON and refused.
	it.each([
		['report.pdf', 'application/pdf'],
		['data.zip', 'application/zip'],
		['blob.bin', ''],
	])('sends a 30 MB %s straight to storage', async (name, type) => {
		const file = fileOfSize(name, 30 * MiB, type)

		expect(await toUploadInput(file)).toEqual({ file })
	})

	it('still reads a 10 MB document as base64 for the JSON path', async () => {
		const input = await toUploadInput(fileOfSize('a.pdf', 10 * MiB, 'application/pdf'))

		expect(input).toMatchObject({ encoding: 'base64', mime_type: 'application/pdf' })
	})

	it('reads a 40 MB video as base64 for the JSON path, which allows it', async () => {
		const input = await toUploadInput(fileOfSize('a.mp4', 40 * MiB))

		expect(input).toMatchObject({ encoding: 'base64' })
	})

	it('refuses a file over the limit', () => {
		expect(() => assertUploadable(fileOfSize('huge.bin', 1024 * MiB + 1))).toThrow(/too large/)
	})
})

describe('uploadLargeFile', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		puts = []
		failUrl = null
		hideEtag = false
		vi.stubGlobal('XMLHttpRequest', FakeXhr)
		vi.mocked(api.files.completeUpload).mockResolvedValue({ id: 'f-1' } as never)
		vi.mocked(api.files.abortUpload).mockResolvedValue({ aborted: true })
	})

	it('uploads every part, then completes with the ETags in part order', async () => {
		vi.mocked(api.files.startUpload).mockResolvedValue(session(4))
		const file = fileOfSize('big.mp4', 50 * MiB)

		const result = await uploadLargeFile('ws-1', file)

		expect(result).toEqual({ id: 'f-1' })
		expect(puts.map((p) => p.url).sort()).toEqual([
			'https://storage.test/p1',
			'https://storage.test/p2',
			'https://storage.test/p3',
			'https://storage.test/p4',
		])
		const parts = vi.mocked(api.files.completeUpload).mock.calls[0]?.[2]
		expect([...(parts ?? [])].sort((a, b) => a.part_number - b.part_number)).toEqual([
			{ part_number: 1, etag: '"etag-of-https://storage.test/p1"' },
			{ part_number: 2, etag: '"etag-of-https://storage.test/p2"' },
			{ part_number: 3, etag: '"etag-of-https://storage.test/p3"' },
			{ part_number: 4, etag: '"etag-of-https://storage.test/p4"' },
		])
	})

	it('declares the real size and type when starting', async () => {
		vi.mocked(api.files.startUpload).mockResolvedValue(session(1))

		await uploadLargeFile('ws-1', fileOfSize('big.mp4', 60 * MiB))

		expect(api.files.startUpload).toHaveBeenCalledWith('ws-1', {
			name: 'big.mp4',
			mime_type: 'video/mp4',
			size_bytes: 60 * MiB,
		})
	})

	it('reports progress that ends at 1', async () => {
		vi.mocked(api.files.startUpload).mockResolvedValue(session(2))
		const seen: number[] = []

		await uploadLargeFile('ws-1', fileOfSize('big.mp4', 20 * MiB), {
			onProgress: (p) => seen.push(p),
		})

		expect(seen.at(-1)).toBe(1)
		expect(Math.max(...seen)).toBeLessThanOrEqual(1)
	})

	it('abandons the upload when a part keeps failing', async () => {
		vi.useFakeTimers()
		vi.mocked(api.files.startUpload).mockResolvedValue(session(2))
		failUrl = 'https://storage.test/p2'

		const promise = uploadLargeFile('ws-1', fileOfSize('big.mp4', 20 * MiB))
		const assertion = expect(promise).rejects.toThrow(/rejected a part/)
		await vi.runAllTimersAsync()
		await assertion

		expect(api.files.abortUpload).toHaveBeenCalledWith('ws-1', 'up-1')
		expect(api.files.completeUpload).not.toHaveBeenCalled()
		vi.useRealTimers()
	})

	it('explains a missing ETag as a CORS problem', async () => {
		vi.useFakeTimers()
		vi.mocked(api.files.startUpload).mockResolvedValue(session(1))
		hideEtag = true

		const promise = uploadLargeFile('ws-1', fileOfSize('big.mp4', 20 * MiB))
		const assertion = expect(promise).rejects.toThrow(/CORS/)
		await vi.runAllTimersAsync()
		await assertion

		vi.useRealTimers()
	})

	it('stops without completing when the caller aborts', async () => {
		vi.mocked(api.files.startUpload).mockResolvedValue(session(2))
		const controller = new AbortController()
		controller.abort()

		await expect(
			uploadLargeFile('ws-1', fileOfSize('big.mp4', 20 * MiB), { signal: controller.signal }),
		).rejects.toThrow(/aborted/)

		expect(api.files.abortUpload).toHaveBeenCalled()
		expect(api.files.completeUpload).not.toHaveBeenCalled()
	})
})
