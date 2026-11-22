import assert from 'node:assert/strict'
import { test } from 'node:test'
import { API_BASE, EconomicClient, buildUrl, safePath } from '../client.js'
import { credentialsFrom } from '../http.js'
import { buildTools, explainFailure } from '../tools.js'

test('only e-conomic paths are accepted', () => {
	assert.equal(safePath('/customers'), 'customers')
	for (const bad of [
		'https://evil.example/x',
		'http:evil',
		'a/../b',
		'a\\b',
		'file:///etc/passwd',
	]) {
		assert.throws(() => safePath(bad), bad)
	}
	// leading slashes are dropped, so this stays a path under the e-conomic host
	assert.equal(new URL(buildUrl('//evil.example/x')).origin, API_BASE)
	assert.ok(buildUrl('customers', { pagesize: 2 }).startsWith(`${API_BASE}/customers?`))
})

test('the client can only issue GET', () => {
	const methods = Object.getOwnPropertyNames(EconomicClient.prototype)
	assert.deepEqual(methods.sort(), ['collection', 'constructor', 'get'])
})

test('no tool name suggests a write, and every tool is a check, list or get', () => {
	const names = buildTools({ appSecretToken: 'a', agreementGrantToken: 'b' }).map((t) => t.name)
	assert.ok(names.length > 20)
	for (const name of names) {
		assert.match(name, /^economic_(check_connection|list_\w+|get_\w+)$/)
		const words = name.split('_')
		for (const bad of ['book', 'create', 'update', 'delete', 'request', 'post', 'put', 'patch']) {
			assert.ok(!words.includes(bad), name)
		}
	}
})

test('tokens come from headers, and both are needed', () => {
	assert.deepEqual(credentialsFrom({ 'x-appsecrettoken': ' a ', 'x-agreementgranttoken': 'b' }), {
		appSecretToken: 'a',
		agreementGrantToken: 'b',
	})
	assert.equal(credentialsFrom({ 'x-appsecrettoken': 'a' }), null)
})

test('the connection check says what to fix when no tokens were sent', async () => {
	const tool = buildTools(null).find((t) => t.name === 'economic_check_connection')
	const out = (await tool?.handler({})) as { ok: boolean; fix: string }
	assert.equal(out.ok, false)
	assert.match(out.fix, /X-AppSecretToken/)
})

test('a call sends tokens only to e-conomic and refuses redirects', async () => {
	const seen: { url: string; init: RequestInit }[] = []
	const real = globalThis.fetch
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		seen.push({ url: String(url), init })
		return new Response('{"collection":[]}', { status: 200 })
	}) as typeof fetch
	try {
		await new EconomicClient({ appSecretToken: 'a', agreementGrantToken: 'b' }).get('customers')
	} finally {
		globalThis.fetch = real
	}
	assert.equal(seen.length, 1)
	assert.ok(seen[0]?.url.startsWith(API_BASE))
	assert.equal(seen[0]?.init.method, 'GET')
	assert.equal(seen[0]?.init.redirect, 'error')
})

test('an error never echoes the tokens', async () => {
	const real = globalThis.fetch
	globalThis.fetch = (async () =>
		new Response('{"message":"bad secret-app-token / secret-grant-token"}', {
			status: 401,
		})) as typeof fetch
	let text = ''
	try {
		await new EconomicClient({
			appSecretToken: 'secret-app-token',
			agreementGrantToken: 'secret-grant-token',
		}).get('customers')
	} catch (err) {
		text = explainFailure(err)
	} finally {
		globalThis.fetch = real
	}
	assert.ok(text.length > 0)
	assert.doesNotMatch(text, /secret-/)
})
