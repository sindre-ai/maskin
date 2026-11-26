import assert from 'node:assert/strict'
import { test } from 'node:test'
import { API_BASE, EconomicClient, MAX_RECEIPT_BYTES } from '../client.js'
import { writesEnabled } from '../server.js'
import { buildTools, explainFailure } from '../tools.js'

const creds = { appSecretToken: 'secret-app-token', agreementGrantToken: 'secret-grant-token' }

interface Seen {
	url: string
	init: RequestInit
}

async function withFetch<T>(answer: () => Response, run: (seen: Seen[]) => Promise<T>): Promise<T> {
	const seen: Seen[] = []
	const real = globalThis.fetch
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		seen.push({ url: String(url), init })
		return answer()
	}) as typeof fetch
	try {
		return await run(seen)
	} finally {
		globalThis.fetch = real
	}
}

const draftArgs = {
	journalNumber: 1,
	accountingYear: '2025',
	date: '2025-03-01',
	text: 'Office supplies',
	amount: 125,
	account: 2100,
	contraAccount: 5820,
}

test('writes are off unless ECONOMIC_WRITES is on', () => {
	assert.equal(writesEnabled({}), false)
	assert.equal(writesEnabled({ ECONOMIC_WRITES: 'yes' }), false)
	assert.equal(writesEnabled({ ECONOMIC_WRITES: 'on' }), true)
})

test('with writes on, the two extra tools are listed and nothing can book, change or delete', () => {
	const off = buildTools(creds).map((t) => t.name)
	const on = buildTools(creds, { writesEnabled: true }).map((t) => t.name)
	assert.deepEqual(on.filter((n) => !off.includes(n)).sort(), [
		'economic_attach_receipt',
		'economic_save_voucher_draft',
	])
	for (const name of on) {
		for (const bad of ['book', 'update', 'delete', 'request', 'put', 'patch']) {
			assert.ok(!name.split('_').includes(bad), name)
		}
	}
})

test('a draft is one finance voucher POSTed to the journal, and says it is not booked', async () => {
	const tool = buildTools(creds, { writesEnabled: true }).find(
		(t) => t.name === 'economic_save_voucher_draft',
	)
	const out = await withFetch(
		() => new Response('[{"voucherNumber":7}]', { status: 201 }),
		async (seen) => {
			const result = (await tool?.handler({ ...draftArgs, vatCode: 'I25' })) as { booked: boolean }
			assert.equal(seen.length, 1)
			assert.equal(seen[0]?.url, `${API_BASE}/journals/1/vouchers`)
			assert.equal(seen[0]?.init.method, 'POST')
			assert.equal(seen[0]?.init.redirect, 'error')
			const body = JSON.parse(String(seen[0]?.init.body))
			assert.deepEqual(body.accountingYear, { year: '2025' })
			assert.deepEqual(body.journal, { journalNumber: 1 })
			assert.deepEqual(body.entries.financeVouchers[0], {
				account: { accountNumber: 2100 },
				contraAccount: { accountNumber: 5820 },
				amount: 125,
				currency: { code: 'DKK' },
				date: '2025-03-01',
				text: 'Office supplies',
				vatAccount: { vatCode: 'I25' },
			})
			return result
		},
	)
	assert.equal(out.booked, false)
})

test('a draft with a bad journal, date or amount is refused before any call', async () => {
	const tool = buildTools(creds, { writesEnabled: true }).find(
		(t) => t.name === 'economic_save_voucher_draft',
	)
	await withFetch(
		() => new Response('{}'),
		async (seen) => {
			for (const bad of [
				{ journalNumber: 0 },
				{ journalNumber: '1/../2' },
				{ date: '1 March' },
				{ amount: '12' },
				{ currency: 'dkk' },
				{ accountingYear: '25' },
			]) {
				await assert.rejects(
					() => tool?.handler({ ...draftArgs, ...bad }) ?? Promise.resolve(),
					String(Object.keys(bad)),
				)
			}
			assert.equal(seen.length, 0)
		},
	)
})

test('a receipt goes as a multipart file to that voucher only', async () => {
	const tool = buildTools(creds, { writesEnabled: true }).find(
		(t) => t.name === 'economic_attach_receipt',
	)
	await withFetch(
		() => new Response('', { status: 200 }),
		async (seen) => {
			await tool?.handler({
				journalNumber: 1,
				accountingYear: '2025',
				voucherNumber: 7,
				filename: '../../receipt 1.pdf',
				mimeType: 'application/pdf',
				contentBase64: Buffer.from('%PDF-1.4 test').toString('base64'),
			})
			assert.equal(seen.length, 1)
			assert.equal(seen[0]?.url, `${API_BASE}/journals/1/vouchers/2025-7/attachment/file`)
			assert.equal(seen[0]?.init.method, 'POST')
			const form = seen[0]?.init.body as FormData
			const file = form.get('file') as File
			assert.equal(file.type, 'application/pdf')
			assert.doesNotMatch(file.name, /[\\/]/)
			assert.equal(await file.text(), '%PDF-1.4 test')
			// the content type header is left to fetch so it carries the multipart boundary
			assert.equal((seen[0]?.init.headers as Record<string, string>)['Content-Type'], undefined)
		},
	)
})

test('a receipt that is the wrong type, empty or too large is refused before any call', async () => {
	const client = new EconomicClient(creds)
	await withFetch(
		() => new Response('{}'),
		async (seen) => {
			const base = { filename: 'a', mimeType: 'application/pdf', bytes: new Uint8Array([1]) }
			await assert.rejects(() =>
				client.attachReceipt(1, '2025', 7, { ...base, mimeType: 'text/html' }),
			)
			await assert.rejects(() =>
				client.attachReceipt(1, '2025', 7, { ...base, bytes: new Uint8Array(0) }),
			)
			await assert.rejects(() =>
				client.attachReceipt(1, '2025', 7, {
					...base,
					bytes: new Uint8Array(MAX_RECEIPT_BYTES + 1),
				}),
			)
			await assert.rejects(() => client.attachReceipt(1, '2025/../x', 7, base))
			await assert.rejects(() => client.attachReceipt(1, '2025', 0, base))
			assert.equal(seen.length, 0)
		},
	)
})

test('a read-only agreement is explained in plain words, without the tokens', async () => {
	const tool = buildTools(creds, { writesEnabled: true }).find(
		(t) => t.name === 'economic_save_voucher_draft',
	)
	await withFetch(
		() =>
			new Response(
				'{"message":"The license is read-only. secret-app-token","errorCode":"E02002"}',
				{
					status: 403,
				},
			),
		async () => {
			const err = await (tool?.handler(draftArgs) ?? Promise.resolve()).catch((e: unknown) => e)
			const text = explainFailure(err)
			assert.match(text, /read-only/)
			assert.doesNotMatch(text, /secret-/)
		},
	)
})
