import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	callbackUrls,
	checkMetadata,
	chooseAuthMethod,
	envPrefix,
	main,
	parseArgs,
	settingsLines,
} from './register-oauth-client.mjs'

const URL_ = 'https://mcp.example.com/.well-known/oauth-authorization-server'
const META = {
	issuer: 'https://mcp.example.com',
	registration_endpoint: 'https://mcp.example.com/register',
	token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
}

test('names the two settings after the vendor', () => {
	assert.equal(envPrefix('notion'), 'NOTION')
	assert.equal(envPrefix('google-ads'), 'GOOGLE_ADS')
	assert.throws(() => envPrefix('No Way'))
})

test('registers a callback for every origin and refuses plain http', () => {
	assert.deepEqual(callbackUrls('notion', ['https://maskin.io', 'https://test.maskin.io/x']), [
		'https://maskin.io/api/integrations/notion/callback',
		'https://test.maskin.io/api/integrations/notion/callback',
	])
	assert.throws(() => callbackUrls('notion', ['http://maskin.io']))
	assert.deepEqual(parseArgs(['notion', URL_]).origins, ['https://maskin.io'])
})

test("refuses a registration address that is not https or not the vendor's own", () => {
	assert.equal(checkMetadata(URL_, META), 'https://mcp.example.com/register')
	assert.throws(() =>
		checkMetadata(URL_, { ...META, registration_endpoint: 'http://mcp.example.com/register' }),
	)
	assert.throws(() =>
		checkMetadata(URL_, { ...META, registration_endpoint: 'https://evil.test/register' }),
	)
	assert.throws(() => checkMetadata(URL_, { ...META, issuer: 'https://other.test' }))
	// The issuer may be the vendor's main host (Airtable: mcp.airtable.com publishes airtable.com).
	assert.equal(
		checkMetadata(URL_, { ...META, issuer: 'https://example.com/oauth2/v1' }),
		'https://mcp.example.com/register',
	)
	assert.throws(() => checkMetadata('http://mcp.example.com/x', META))
})

test('prefers a client secret, falls back to basic then no-secret, refuses anything else', () => {
	assert.equal(chooseAuthMethod(META), 'client_secret_post')
	assert.equal(
		chooseAuthMethod({ token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'] }),
		'client_secret_basic',
	)
	assert.equal(chooseAuthMethod({ token_endpoint_auth_methods_supported: ['none'] }), 'none')
	assert.throws(() =>
		chooseAuthMethod({ token_endpoint_auth_methods_supported: ['private_key_jwt'] }),
	)
})

test('prints the two lines, and refuses an answer without an id or secret', () => {
	assert.equal(
		settingsLines('notion', { client_id: 'abc', client_secret: 'shh' }),
		'NOTION_CLIENT_ID=abc\nNOTION_CLIENT_SECRET=shh\n',
	)
	assert.throws(() => settingsLines('notion', { client_secret: 'shh' }))
})

test('an answer with no secret prints the id line only, even when a secret method was asked for', () => {
	assert.equal(settingsLines('amplitude', { client_id: 'abc' }), 'AMPLITUDE_CLIENT_ID=abc\n')
})

test('--auth-method picks the method, and refuses an unknown one', () => {
	assert.equal(parseArgs(['amplitude', URL_, '--auth-method', 'none']).authMethod, 'none')
	assert.equal(parseArgs(['amplitude', URL_]).authMethod, undefined)
	assert.throws(() => parseArgs(['amplitude', URL_, '--auth-method', 'private_key_jwt']))
})

test('a no-secret vendor prints the id line only', () => {
	assert.equal(settingsLines('stripe', { client_id: 'abc' }, 'none'), 'STRIPE_CLIENT_ID=abc\n')
	assert.throws(() => settingsLines('stripe', {}, 'none'))
})

test('end to end with a stub vendor: secret only on stdout', async () => {
	let sent
	const fetch = async (url, init) => {
		if (String(url) === URL_) return Response.json(META)
		sent = JSON.parse(init.body)
		return Response.json({ client_id: 'id-1', client_secret: 'secret-1' })
	}
	let out = ''
	let err = ''
	const code = await main(['notion', URL_, '--origin', 'https://maskin.io'], {
		fetch,
		stdout: (s) => {
			out += s
		},
		stderr: (s) => {
			err += s
		},
	})
	assert.equal(code, 0)
	assert.equal(out, 'NOTION_CLIENT_ID=id-1\nNOTION_CLIENT_SECRET=secret-1\n')
	assert.ok(!err.includes('secret-1'))
	assert.deepEqual(sent.redirect_uris, ['https://maskin.io/api/integrations/notion/callback'])
	assert.equal(sent.token_endpoint_auth_method, 'client_secret_post')
})

test('a vendor refusal exits 1 and prints no settings', async () => {
	const fetch = async (url) =>
		String(url) === URL_ ? Response.json(META) : new Response('no', { status: 403 })
	let out = ''
	const code = await main(['notion', URL_], {
		fetch,
		stdout: (s) => {
			out += s
		},
		stderr: () => {},
	})
	assert.equal(code, 1)
	assert.equal(out, '')
})

test('end to end with Stripe-shaped details: no-secret client, id only on stdout', async () => {
	const stripeUrl = 'https://access.stripe.com/.well-known/oauth-authorization-server/mcp'
	let sent
	const fetch = async (url, init) => {
		if (String(url) === stripeUrl) {
			return Response.json({
				issuer: 'https://access.stripe.com/mcp',
				registration_endpoint: 'https://access.stripe.com/mcp/oauth2/register',
				token_endpoint_auth_methods_supported: ['none'],
			})
		}
		sent = JSON.parse(init.body)
		return Response.json({ client_id: 'id-2' })
	}
	let out = ''
	const code = await main(['stripe', stripeUrl], {
		fetch,
		stdout: (s) => {
			out += s
		},
		stderr: () => {},
	})
	assert.equal(code, 0)
	assert.equal(out, 'STRIPE_CLIENT_ID=id-2\n')
	assert.equal(sent.token_endpoint_auth_method, 'none')
	assert.deepEqual(sent.redirect_uris, ['https://maskin.io/api/integrations/stripe/callback'])
})

test('end to end with an Amplitude-shaped vendor: no secret in the answer, id still printed', async () => {
	let sent
	const fetch = async (url, init) => {
		if (String(url) === URL_) return Response.json(META)
		sent = JSON.parse(init.body)
		return Response.json({ client_id: 'id-3', token_endpoint_auth_method: 'none' })
	}
	let out = ''
	let err = ''
	const code = await main(['amplitude', URL_], {
		fetch,
		stdout: (s) => {
			out += s
		},
		stderr: (s) => {
			err += s
		},
	})
	assert.equal(code, 0)
	assert.equal(out, 'AMPLITUDE_CLIENT_ID=id-3\n')
	assert.equal(sent.token_endpoint_auth_method, 'client_secret_post')
	assert.ok(err.includes('public client'))
})

test('--auth-method none asks the vendor for a no-secret client', async () => {
	let sent
	const fetch = async (url, init) => {
		if (String(url) === URL_) return Response.json(META)
		sent = JSON.parse(init.body)
		return Response.json({ client_id: 'id-4' })
	}
	let out = ''
	const code = await main(['amplitude', URL_, '--auth-method', 'none'], {
		fetch,
		stdout: (s) => {
			out += s
		},
		stderr: () => {},
	})
	assert.equal(code, 0)
	assert.equal(out, 'AMPLITUDE_CLIENT_ID=id-4\n')
	assert.equal(sent.token_endpoint_auth_method, 'none')
})
