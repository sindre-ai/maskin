import { describe, expect, it } from 'vitest'
import {
	createLinkedInHttpClient,
	normalizePostAs,
} from '../../../../../lib/integrations/providers/linkedin-unipile/unipile-client'

/**
 * v2 "Create posts" guide, "Publish on behalf of a company": `post_as` takes the
 * plain company id (`'123456'`). We hold the URN, so the client must reduce it
 * on the wire. The company page post 403'd with "not an admin" while the URN went out.
 */
function recordingClient() {
	const calls: Array<{ url: string; body: Record<string, unknown> }> = []
	const fetchImpl = (async (url: string, init: RequestInit) => {
		calls.push({ url, body: JSON.parse(String(init.body)) })
		return new Response(JSON.stringify({ object: 'PostCreated', post_id: 'p1' }), { status: 200 })
	}) as unknown as typeof fetch
	const client = createLinkedInHttpClient({
		baseUrl: 'https://api.unipile.test',
		apiKey: 'k',
		fetchImpl,
	})
	return { client, calls }
}

describe('publishPost post_as', () => {
	it('sends the plain company id when given a company URN', async () => {
		const { client, calls } = recordingClient()
		await client.publishPost({
			account_id: 'acc_1',
			text: 'hello',
			post_as: 'urn:li:organization:130474200',
		})
		expect(calls[0].url).toBe('https://api.unipile.test/v2/acc_1/posts')
		expect(calls[0].body).toEqual({ text: 'hello', post_as: '130474200' })
	})

	it('passes a plain id through and omits post_as for a personal post', async () => {
		const { client, calls } = recordingClient()
		await client.publishPost({ account_id: 'acc_1', text: 'a', post_as: '130474200' })
		await client.publishPost({ account_id: 'acc_1', text: 'b' })
		expect(calls[0].body).toEqual({ text: 'a', post_as: '130474200' })
		expect(calls[1].body).toEqual({ text: 'b' })
	})
})

describe('normalizePostAs', () => {
	it('strips the organization URN prefix only', () => {
		expect(normalizePostAs('urn:li:organization:42')).toBe('42')
		expect(normalizePostAs(' URN:LI:ORGANIZATION:42 ')).toBe('42')
		expect(normalizePostAs('42')).toBe('42')
	})
})
