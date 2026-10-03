import { type Server, createServer } from 'node:http'
import { expect, test } from '@playwright/test'
import { TestAPI, createTestActor } from '../helpers/api.helper'
import { E2E_TELNYX_STUB_PORT } from '../helpers/telnyx.helper'

// Knowledge round-trip (bet 5b8e): flip a knowledge object to customer_facing and the exporter
// pushes its markdown to the Telnyx knowledge bucket within 60 seconds, then attaches the
// retrieval tool to the assistant. Telnyx is a stub server here; its knowledge endpoints are
// UNVERIFIED against live Telnyx, so this proves our side of the contract only.

interface StubRequest {
	method: string
	url: string
	body: Record<string, unknown>
}

let stub: Server
let requests: StubRequest[] = []

test.beforeAll(async () => {
	stub = createServer((req, res) => {
		let raw = ''
		req.on('data', (chunk) => {
			raw += chunk
		})
		req.on('end', () => {
			const url = req.url ?? ''
			const method = req.method ?? ''
			requests.push({ method, url, body: raw ? JSON.parse(raw) : {} })
			res.setHeader('Content-Type', 'application/json')
			if (method === 'GET' && url.startsWith('/v2/ai/assistants/')) {
				res.statusCode = 404
				res.end(JSON.stringify({ errors: [{ title: 'not found' }] }))
			} else if (url === '/v2/ai/embeddings') {
				res.end(JSON.stringify({ data: { tool_id: 'stub-retrieval-tool' } }))
			} else if (url.startsWith('/v2/ai/assistants')) {
				res.end(
					JSON.stringify({ data: { id: 'stub-assistant', tool_ids: ['stub-retrieval-tool'] } }),
				)
			} else {
				res.end(JSON.stringify({ data: {} }))
			}
		})
	})
	await new Promise<void>((resolve) => stub.listen(E2E_TELNYX_STUB_PORT, '127.0.0.1', resolve))
})

test.afterAll(async () => {
	await new Promise<void>((resolve) => stub.close(() => resolve()))
})

test.beforeEach(() => {
	requests = []
})

test.describe('Telnyx knowledge export: end to end', () => {
	test('a knowledge object flipped to customer_facing reaches the bucket within 60s, an unflagged one never does', async () => {
		const actor = await createTestActor({ name: `E2E Voice knowledge ${Date.now()}` })
		const api = new TestAPI(actor.api_key)
		const workspace = (await api.listWorkspaces())[0]
		if (!workspace) throw new Error('No workspace found after actor creation')

		// The exporter only serves workspaces with an active Telnyx integration.
		const connect = await fetch('http://localhost:3000/api/integrations/telnyx/connect', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${actor.api_key}`,
				'X-Workspace-Id': workspace.id,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ api_key: 'e2e-telnyx-key' }),
		})
		expect(connect.status).toBeLessThan(400)

		const title = `Security FAQ ${Date.now()}`
		const secret = `Internal roadmap ${Date.now()}`
		const flagged = await api.createObject(workspace.id, {
			type: 'knowledge',
			title,
			status: 'validated',
			content: 'Customer data stays in the EU.',
			metadata: { summary: 'Security answers', customer_facing: false },
		})
		await api.createObject(workspace.id, {
			type: 'knowledge',
			title: secret,
			status: 'validated',
			content: 'Never leaves the workspace.',
			metadata: { summary: 'Internal', customer_facing: false },
		})

		await api.updateObject(flagged.id, workspace.id, {
			metadata: { summary: 'Security answers', customer_facing: true },
		})

		await expect
			.poll(
				() =>
					requests.find(
						(r) =>
							r.method === 'PUT' &&
							r.url.includes(`/objects/${flagged.id}.md`) &&
							String(r.body.content).includes('Customer data stays in the EU.'),
					),
				{ timeout: 60_000, message: 'exporter did not upload the flagged object in time' },
			)
			.toBeTruthy()

		const upload = requests.find((r) => r.method === 'PUT' && r.url.includes(flagged.id))
		expect(upload?.url).toContain(`/v2/ai/embeddings/buckets/maskin-kb-${workspace.id}/`)
		expect(String(upload?.body.content)).toContain(`# ${title}`)

		// The unflagged object is nowhere in anything sent to Telnyx.
		expect(JSON.stringify(requests)).not.toContain(secret)

		// The retrieval tool is attached to the assistant.
		await expect
			.poll(() =>
				requests.some(
					(r) =>
						r.url.startsWith('/v2/ai/assistants') &&
						(r.method === 'POST' || r.method === 'PATCH') &&
						JSON.stringify(r.body.tool_ids ?? []).includes('stub-retrieval-tool'),
				),
			)
			.toBe(true)
	})
})
