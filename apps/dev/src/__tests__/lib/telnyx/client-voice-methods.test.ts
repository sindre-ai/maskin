import { describe, expect, it, vi } from 'vitest'
import { createTelnyxClient } from '../../../lib/integrations/providers/telnyx/client'

type Reply = { status?: number; body?: unknown }

function client(replies: Reply[]) {
	const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = []
	let i = 0
	const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({
			method: init?.method ?? 'GET',
			url: String(url),
			body: init?.body ? JSON.parse(init.body as string) : {},
		})
		const reply = replies[Math.min(i++, replies.length - 1)] ?? {}
		return new Response(JSON.stringify(reply.body ?? { data: {} }), { status: reply.status ?? 200 })
	})
	return {
		calls,
		api: createTelnyxClient({
			apiKey: 'k',
			baseUrl: 'https://telnyx.test',
			fetchImpl: fetchImpl as unknown as typeof fetch,
			sleep: async () => {},
			random: () => 0,
		}),
	}
}

describe('telnyx client: voice methods', () => {
	it('transfers a call warm, with a 15s ring timeout and the summary as SIP custom headers', async () => {
		const { api, calls } = client([{}])
		await api.transferCall('v3:call/1', {
			to: '+4570123456',
			from: '+4522222222',
			timeoutSecs: 15,
			customHeaders: [{ name: 'X-Maskin-Summary', value: 'Pia: wants a call now' }],
		})
		expect(calls[0]).toMatchObject({
			method: 'POST',
			url: 'https://telnyx.test/v2/calls/v3%3Acall%2F1/actions/transfer',
			body: {
				to: '+4570123456',
				from: '+4522222222',
				warm: true,
				timeout_secs: 15,
				custom_headers: [{ name: 'X-Maskin-Summary', value: 'Pia: wants a call now' }],
			},
		})
	})

	it('reads an assistant, and answers null for a 404', async () => {
		const found = client([{ body: { data: { id: 'a1', description: 'd', tool_ids: ['t1'] } } }])
		expect(await found.api.getAssistant('a1')).toEqual({
			id: 'a1',
			description: 'd',
			toolIds: ['t1'],
		})
		const missing = client([{ status: 404, body: { errors: [] } }])
		expect(await missing.api.getAssistant('gone')).toBeNull()
	})

	it('creates and patches an assistant with the payload as given', async () => {
		const { api, calls } = client([{ body: { data: { id: 'new' } } }])
		expect((await api.createAssistant({ name: 'x' })).id).toBe('new')
		await api.updateAssistant('new', { name: 'y' })
		expect(calls.map((c) => [c.method, c.url])).toEqual([
			['POST', 'https://telnyx.test/v2/ai/assistants'],
			['PATCH', 'https://telnyx.test/v2/ai/assistants/new'],
		])
		expect(calls[1]?.body).toEqual({ name: 'y' })
	})

	it('reads conversation messages, dropping entries without a role or text', async () => {
		const { api, calls } = client([
			{
				body: {
					data: [
						{ role: 'assistant', text: 'confirm line' },
						{ role: 'user', content: 'yes' },
						{ text: 'no role' },
						{ role: 'user' },
					],
				},
			},
		])
		expect(await api.getConversationMessages('conv/1')).toEqual([
			{ role: 'assistant', text: 'confirm line' },
			{ role: 'user', text: 'yes' },
		])
		expect(calls[0]?.url).toBe('https://telnyx.test/v2/ai/conversations/conv%2F1/messages')
	})

	it('syncs a knowledge bucket: create, one upload per document, embed, return the tool id', async () => {
		const { api, calls } = client([{}, {}, {}, { body: { data: { tool_id: 'kb-tool' } } }])
		const out = await api.syncKnowledgeBucket('maskin-kb-ws', [
			{ name: 'a.md', markdown: '# A' },
			{ name: 'b.md', markdown: '# B' },
		])
		expect(out).toEqual({ retrievalToolId: 'kb-tool' })
		expect(calls.map((c) => `${c.method} ${c.url.replace('https://telnyx.test', '')}`)).toEqual([
			'POST /v2/ai/embeddings/buckets',
			'PUT /v2/ai/embeddings/buckets/maskin-kb-ws/objects/a.md',
			'PUT /v2/ai/embeddings/buckets/maskin-kb-ws/objects/b.md',
			'POST /v2/ai/embeddings',
		])
		expect(calls[1]?.body).toEqual({ content: '# A', content_type: 'text/markdown' })
		expect(calls[3]?.body).toEqual({ bucket_name: 'maskin-kb-ws' })
	})

	it('treats a bucket that already exists as fine, and surfaces any other failure', async () => {
		const exists = client([{ status: 409, body: {} }, {}, { body: { data: { tool_id: 't' } } }])
		expect(
			(await exists.api.syncKnowledgeBucket('b', [{ name: 'a.md', markdown: '#' }]))
				.retrievalToolId,
		).toBe('t')
		const denied = client([{ status: 403, body: {} }])
		await expect(denied.api.syncKnowledgeBucket('b', [])).rejects.toThrow()
	})
})
