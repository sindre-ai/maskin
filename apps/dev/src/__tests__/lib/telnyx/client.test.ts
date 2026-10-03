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
