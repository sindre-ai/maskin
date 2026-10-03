import { describe, expect, it, vi } from 'vitest'
import { createTelnyxClient } from '../../../lib/integrations/providers/telnyx/client'

function clientWith(body: unknown, status = 200) {
	const fetchImpl = vi.fn(
		async () => new Response(JSON.stringify(body), { status }),
	) as unknown as typeof fetch
	return {
		fetchImpl,
		client: createTelnyxClient({ apiKey: 'k', baseUrl: 'https://telnyx.test', fetchImpl }),
	}
}

describe('TelnyxClient.findRecording', () => {
	it('asks for the recordings of the call and returns the first one with its mp3 url', async () => {
		const { client, fetchImpl } = clientWith({
			data: [
				{
					id: 'rec-1',
					status: 'completed',
					download_urls: { mp3: 'https://files.test/rec.mp3', wav: 'https://files.test/rec.wav' },
				},
			],
		})

		expect(await client.findRecording('v3:abc/def')).toEqual({
			recordingId: 'rec-1',
			status: 'completed',
			mp3Url: 'https://files.test/rec.mp3',
		})
		const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://telnyx.test/v2/recordings?filter[call_control_id]=v3%3Aabc%2Fdef')
		expect(init.method).toBe('GET')
	})

	it('returns null when Telnyx has no recording for the call yet', async () => {
		const { client } = clientWith({ data: [] })
		expect(await client.findRecording('call-1')).toBeNull()
	})

	it('reports a recording that has no download url yet', async () => {
		const { client } = clientWith({ data: [{ id: 'rec-2', status: 'processing' }] })
		expect(await client.findRecording('call-1')).toEqual({
			recordingId: 'rec-2',
			status: 'processing',
			mp3Url: null,
		})
	})
})

describe('TelnyxClient.listRecordings', () => {
	it('returns every recording Telnyx hosts for the call, and an empty list when there are none', async () => {
		const { client, fetchImpl } = clientWith({
			data: [
				{ id: 'rec-1', status: 'completed', download_urls: { mp3: 'https://files.test/1.mp3' } },
				{ id: 'rec-2', status: 'processing' },
			],
		})

		expect(await client.listRecordings('call-1')).toEqual([
			{ recordingId: 'rec-1', status: 'completed', mp3Url: 'https://files.test/1.mp3' },
			{ recordingId: 'rec-2', status: 'processing', mp3Url: null },
		])
		const [url] = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://telnyx.test/v2/recordings?filter[call_control_id]=call-1')

		expect(await clientWith({ data: [] }).client.listRecordings('call-1')).toEqual([])
	})

	it('throws on a 404 rather than reading it as no recordings', async () => {
		const { client } = clientWith({ errors: [{ title: 'Not found' }] }, 404)
		await expect(client.listRecordings('call-1')).rejects.toThrow(/404/)
	})
})

describe('TelnyxClient.deleteRecording', () => {
	it('sends DELETE /v2/recordings/{id} with the bearer key and reports deleted', async () => {
		const { client, fetchImpl } = clientWith({ data: { id: 'rec/1', status: 'deleted' } })

		expect(await client.deleteRecording('rec/1')).toBe('deleted')
		const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://telnyx.test/v2/recordings/rec%2F1')
		expect(init.method).toBe('DELETE')
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k')
	})

	it('reports not_found for a recording Telnyx says does not exist, so an earlier half-run does not loop', async () => {
		const { client } = clientWith({ errors: [{ title: 'Resource not found' }] }, 404)
		expect(await client.deleteRecording('rec-1')).toBe('not_found')
	})

	it('throws on 401, so a bad key is never read as deleted', async () => {
		const { client } = clientWith({ errors: [{ title: 'Unauthorized' }] }, 401)
		await expect(client.deleteRecording('rec-1')).rejects.toThrow(/401/)
	})

	it('throws when Telnyx keeps failing with a 5xx after its retries', async () => {
		const fetchImpl = vi.fn(
			async () => new Response('down', { status: 503 }),
		) as unknown as typeof fetch
		const client = createTelnyxClient({
			apiKey: 'k',
			baseUrl: 'https://telnyx.test',
			fetchImpl,
			sleep: async () => {},
		})
		await expect(client.deleteRecording('rec-1')).rejects.toThrow(/503/)
		expect(fetchImpl).toHaveBeenCalledTimes(3)
	})
})
