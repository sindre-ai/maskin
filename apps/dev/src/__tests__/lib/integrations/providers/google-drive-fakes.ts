import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import type { DriveHttp } from '../../../../lib/integrations/providers/google-drive/write-http'

export const SESSION_URI = 'https://www.googleapis.com/upload/drive/v3/files?upload_id=SESSION-1'

export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers },
	})
}

export function googleError(status: number, message: string, reason?: string, extra?: object) {
	return jsonResponse(
		{ error: { code: status, message, ...(reason && { errors: [{ reason }] }), ...extra } },
		status,
	)
}

export function makeHttp(fetchImpl: typeof fetch): DriveHttp & { sleep: ReturnType<typeof vi.fn> } {
	return {
		fetchImpl,
		getAccessToken: async () => 'ya29.test',
		sleep: vi.fn(async () => {}),
	}
}

export interface PutCall {
	contentRange: string
	contentLength?: string
	bytes: number
}

/**
 * In-memory stand-in for Drive's resumable-upload endpoint. It keeps the bytes
 * it has committed so a test can compare the final sha256 with the source.
 * dropAtByte simulates a TCP drop: the PUT that crosses that offset commits up
 * to it (a 256 KiB multiple) and then rejects, once.
 */
export function fakeResumableDrive(opts: { dropAtByte?: number; expireSession?: boolean } = {}) {
	const committed: Buffer[] = []
	let committedLen = 0
	let dropped = false
	const puts: PutCall[] = []
	const starts: { url: string; headers: Record<string, string>; body: string }[] = []

	const file = (total: number) => ({
		id: 'file-1',
		name: 'big.bin',
		mimeType: 'application/octet-stream',
		webViewLink: 'https://drive.google.com/file/d/file-1/view',
		version: '3',
		size: String(total),
	})

	const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const u = String(url)
		const headers = (init?.headers ?? {}) as Record<string, string>
		if (init?.method === 'POST' && u.includes('uploadType=resumable')) {
			starts.push({ url: u, headers, body: String(init.body) })
			return new Response(null, { status: 200, headers: { location: SESSION_URI } })
		}
		if (init?.method === 'PUT' && u === SESSION_URI) {
			const range = headers['Content-Range'] ?? ''
			const body = init.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0)
			puts.push({
				contentRange: range,
				contentLength: headers['Content-Length'],
				bytes: body.length,
			})
			if (opts.expireSession) return new Response('gone', { status: 404 })
			const status = /^bytes \*\/(\d+|\*)$/.exec(range)
			const data = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(range)
			if (status) {
				const total = status[1]
				if (total !== '*' && committedLen === Number(total)) {
					return jsonResponse(file(committedLen), 200)
				}
				return new Response(null, {
					status: 308,
					headers: committedLen > 0 ? { range: `bytes=0-${committedLen - 1}` } : {},
				})
			}
			if (!data) throw new Error(`unexpected Content-Range ${range}`)
			const start = Number(data[1])
			if (start !== committedLen) throw new Error(`gap: start ${start}, committed ${committedLen}`)
			if (opts.dropAtByte !== undefined && !dropped && start + body.length > opts.dropAtByte) {
				dropped = true
				const keep = opts.dropAtByte - start
				committed.push(body.subarray(0, keep))
				committedLen += keep
				throw new TypeError('terminated: other side closed')
			}
			committed.push(body)
			committedLen += body.length
			const total = data[3]
			if (total !== '*' && committedLen === Number(total))
				return jsonResponse(file(committedLen), 200)
			return new Response(null, { status: 308, headers: { range: `bytes=0-${committedLen - 1}` } })
		}
		throw new Error(`unexpected request ${init?.method} ${u}`)
	})

	return {
		fetchImpl: fetchImpl as unknown as typeof fetch,
		puts,
		starts,
		received: () => Buffer.concat(committed),
	}
}

export async function* pieces(data: Buffer, size: number): AsyncGenerator<Uint8Array> {
	for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size)
}
