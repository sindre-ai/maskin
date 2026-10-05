import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { createDefaultDriveClient } from '../../../../../lib/integrations/providers/google-drive/client'

const json = (status: number, payload: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(payload), { status, headers })

const query = { q: "'f1' in parents", pageSize: 10, fields: 'files(id)' }

describe('drive client listFiles', () => {
	it('GETs /drive/v3/files with bearer auth, shared-drive flags and the query params', async () => {
		const fetchImpl = vi.fn(async () => json(200, { files: [{ id: 'a' }] }))
		const client = createDefaultDriveClient(fetchImpl as never, async () => undefined)

		const res = await client.listFiles('tok', { ...query, pageToken: 'p2', orderBy: 'name' })

		expect(res.files).toEqual([{ id: 'a' }])
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		const u = new URL(url)
		expect(u.origin + u.pathname).toBe('https://www.googleapis.com/drive/v3/files')
		expect(u.searchParams.get('q')).toBe("'f1' in parents")
		expect(u.searchParams.get('pageSize')).toBe('10')
		expect(u.searchParams.get('pageToken')).toBe('p2')
		expect(u.searchParams.get('orderBy')).toBe('name')
		expect(u.searchParams.get('supportsAllDrives')).toBe('true')
		expect(u.searchParams.get('includeItemsFromAllDrives')).toBe('true')
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
	})

	it('retries a 429 then succeeds, honouring Retry-After', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(json(429, {}, { 'retry-after': '2' }))
			.mockResolvedValueOnce(json(200, { files: [] }))
		const sleep = vi.fn(async () => undefined)
		const client = createDefaultDriveClient(fetchImpl as never, sleep)

		await client.listFiles('tok', query)

		expect(fetchImpl).toHaveBeenCalledTimes(2)
		expect(sleep).toHaveBeenCalledWith(2000)
	})

	it('retries 5xx, and surfaces PROVIDER_ERROR once the attempts run out', async () => {
		const fetchImpl = vi.fn(async () => json(503, {}))
		const client = createDefaultDriveClient(fetchImpl as never, async () => undefined)

		await expect(client.listFiles('tok', query)).rejects.toMatchObject({
			code: 'PROVIDER_ERROR',
			providerStatus: 503,
		})
		expect(fetchImpl).toHaveBeenCalledTimes(4)
	})

	it('does not retry a 404; it classifies it', async () => {
		const fetchImpl = vi.fn(async () => json(404, { error: { errors: [{ reason: 'notFound' }] } }))
		const client = createDefaultDriveClient(fetchImpl as never, async () => undefined)

		await expect(client.listFiles('tok', query)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it('turns exhausted network failures into PROVIDER_ERROR', async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error('ECONNRESET')
		})
		const client = createDefaultDriveClient(fetchImpl as never, async () => undefined)
		await expect(client.listFiles('tok', query)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
	})
})
