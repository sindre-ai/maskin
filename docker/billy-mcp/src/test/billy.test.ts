import assert from 'node:assert/strict'
import { test } from 'node:test'
import { API_BASE, BillyClient, buildUrl, safePath } from '../client.js'
import { credentialsFrom } from '../http.js'
import { buildTools, explainFailure, pickBill } from '../tools.js'

type Seen = { url: string; init: RequestInit }

async function withFetch<T>(
	answer: (url: string, init: RequestInit) => Response,
	run: (seen: Seen[]) => Promise<T>,
): Promise<T> {
	const seen: Seen[] = []
	const real = globalThis.fetch
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		seen.push({ url: String(url), init })
		return answer(String(url), init)
	}) as typeof fetch
	try {
		return await run(seen)
	} finally {
		globalThis.fetch = real
	}
}

test('only Billy paths are accepted', () => {
	assert.equal(safePath('/bills'), 'bills')
	for (const bad of [
		'https://evil.example/x',
		'http:evil',
		'a/../b',
		'a\\b',
		'file:///etc/passwd',
	]) {
		assert.throws(() => safePath(bad), bad)
	}
	assert.ok(buildUrl('//evil.example/x').startsWith(`${API_BASE}/`))
	assert.ok(buildUrl('bills', { page: 2 }).startsWith(`${API_BASE}/bills?`))
})

test('the client has no update, delete or approve call', () => {
	const methods = Object.getOwnPropertyNames(BillyClient.prototype).sort()
	assert.deepEqual(methods, [
		'attachFileToBill',
		'collection',
		'constructor',
		'createDraftBill',
		'get',
		'send',
		'uploadFile',
	])
})

test('the tool list is checks, reads, one draft bill and one receipt upload', () => {
	const names = buildTools({ accessToken: 't' }).map((t) => t.name)
	for (const name of names) {
		assert.match(
			name,
			/^billy_(check_connection|get_organization|list_\w+|get_\w+|save_draft_bill|attach_receipt)$/,
		)
		for (const bad of ['approve', 'void', 'update', 'delete', 'pay', 'send', 'request']) {
			assert.ok(!name.split('_').includes(bad), name)
		}
	}
	assert.ok(names.includes('billy_save_draft_bill'))
	assert.ok(names.includes('billy_attach_receipt'))
})

test('the token comes from a header', () => {
	assert.deepEqual(credentialsFrom({ 'x-access-token': ' abc ' }), { accessToken: 'abc' })
	assert.equal(credentialsFrom({}), null)
})

test('the connection check says what to fix when no token was sent', async () => {
	const tool = buildTools(null).find((t) => t.name === 'billy_check_connection')
	const out = (await tool?.handler({})) as { ok: boolean; fix: string }
	assert.equal(out.ok, false)
	assert.match(out.fix, /X-Access-Token/)
})

test('a call sends the token only to Billy and refuses redirects', async () => {
	await withFetch(
		() => new Response('{"organization":{"id":"o1","name":"Test ApS"}}', { status: 200 }),
		async (seen) => {
			const tool = buildTools({ accessToken: 'tok' }).find(
				(t) => t.name === 'billy_check_connection',
			)
			const out = (await tool?.handler({})) as { ok: boolean; company: string }
			assert.deepEqual(out, { ok: true, company: 'Test ApS' })
			assert.equal(seen.length, 1)
			assert.ok(seen[0]?.url.startsWith(API_BASE))
			assert.equal(seen[0]?.init.method, 'GET')
			assert.equal(seen[0]?.init.redirect, 'error')
		},
	)
})

test('a bill is always saved as a draft, whatever the caller sends', async () => {
	await withFetch(
		(url) =>
			url.endsWith('/organization')
				? new Response('{"organization":{"id":"o1"}}', { status: 200 })
				: new Response('{"bills":[{"id":"b1","state":"draft"}]}', { status: 200 }),
		async (seen) => {
			const tool = buildTools({ accessToken: 'tok' }).find(
				(t) => t.name === 'billy_save_draft_bill',
			)
			await tool?.handler({
				contactId: 'c1',
				entryDate: '2026-01-31',
				state: 'approved',
				lines: [{ accountId: 'a1', amount: 100, description: 'Paper', taxRateId: 't1' }],
			})
			const post = seen.find((s) => s.init.method === 'POST')
			assert.ok(post?.url.endsWith('/bills'))
			const sent = JSON.parse(String(post?.init.body)).bill
			assert.equal(sent.state, 'draft')
			assert.equal(sent.organizationId, 'o1')
			assert.equal(sent.lines[0].accountId, 'a1')
		},
	)
})

test('bill input is checked and unknown fields are dropped', () => {
	assert.throws(
		() => pickBill({ contactId: 'c', entryDate: 'tomorrow', lines: [] }, 'o'),
		/entryDate/,
	)
	assert.throws(() => pickBill({ contactId: 'c', entryDate: '2026-01-01', lines: [] }, 'o'), /line/)
	assert.throws(
		() => pickBill({ contactId: '../x', entryDate: '2026-01-01', lines: [{}] }, 'o'),
		/contactId/,
	)
	const bill = pickBill(
		{
			contactId: 'c',
			entryDate: '2026-01-01',
			isPaid: true,
			lines: [{ accountId: 'a', amount: 5, extra: 1 }],
		},
		'o',
	)
	assert.equal('isPaid' in bill, false)
	assert.deepEqual((bill.lines as object[])[0], { accountId: 'a', amount: 5, description: '' })
})

test('a receipt is uploaded, then attached to the bill, and the bill is not changed', async () => {
	await withFetch(
		(url) => {
			if (url.endsWith('/organization'))
				return new Response('{"organization":{"id":"o1"}}', { status: 200 })
			if (url.endsWith('/files')) return new Response('{"files":[{"id":"f1"}]}', { status: 200 })
			return new Response('{"attachments":[{"id":"x1"}]}', { status: 200 })
		},
		async (seen) => {
			const tool = buildTools({ accessToken: 'tok' }).find((t) => t.name === 'billy_attach_receipt')
			await tool?.handler({
				billId: 'b1',
				fileName: 'kvittering æ.pdf',
				contentType: 'application/pdf',
				contentBase64: Buffer.from('%PDF-1.4').toString('base64'),
			})
			const posts = seen.filter((s) => s.init.method === 'POST')
			assert.deepEqual(
				posts.map((p) => p.url.replace(API_BASE, '')),
				['/files', '/attachments'],
			)
			const headers = posts[0]?.init.headers as Record<string, string>
			assert.equal(headers['X-OrganizationId'], 'o1')
			assert.equal(headers['X-Filename'], encodeURIComponent('kvittering æ.pdf'))
			assert.deepEqual(JSON.parse(String(posts[1]?.init.body)), {
				attachment: { ownerReference: 'bill:b1', fileId: 'f1' },
			})
		},
	)
})

test('an error never echoes the token', async () => {
	await withFetch(
		() => new Response('{"errorMessage":"bad token secret-billy-token"}', { status: 401 }),
		async () => {
			let text = ''
			try {
				await new BillyClient({ accessToken: 'secret-billy-token' }).get('bills')
			} catch (err) {
				text = explainFailure(err)
			}
			assert.ok(text.length > 0)
			assert.doesNotMatch(text, /secret-/)
		},
	)
})
