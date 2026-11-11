#!/usr/bin/env node
/**
 * One-time registration of Maskin as an OAuth client with a vendor's hosted MCP server
 * (RFC 7591 dynamic client registration), for the connect-a-tool bet.
 *
 *   node scripts/register-oauth-client.mjs <vendor> <metadata-url> [--origin https://maskin.io]... [--auth-method none]
 *
 *   node scripts/register-oauth-client.mjs notion https://mcp.notion.com/.well-known/oauth-authorization-server
 *   node scripts/register-oauth-client.mjs stripe https://access.stripe.com/.well-known/oauth-authorization-server/mcp
 *
 * <vendor> is the provider name in the registry (notion). <metadata-url> is the vendor's published
 * sign-in details (RFC 8414). Each --origin is a public origin Maskin runs on; the callback
 * `{origin}/api/integrations/{vendor}/callback` is registered for every one, in one registration.
 * With no --origin, https://maskin.io. --auth-method (client_secret_post, client_secret_basic or none)
 * asks for that method instead of the one picked from the vendor's list.
 *
 * Output: the settings lines, NAME_CLIENT_ID=... and NAME_CLIENT_SECRET=... (only the id line for a
 * vendor that offers just no-secret clients, like Stripe, or that answers with no secret, like
 * Amplitude), on stdout. Run it in a
 * terminal and set the values on the server by hand. Never put the output in a log, comment, task or
 * file. Everything else it says goes to stderr and holds no secret.
 *
 * Checks before it sends anything: the metadata URL and the registration address are https, the
 * registration address is on the vendor's own domain, and the issuer matches the metadata host.
 * Exit codes: 0 ok, 1 refused or failed.
 *
 * Node 20, no dependencies. Pure functions are exported for tests; main runs only when the file
 * is invoked directly.
 */

import { pathToFileURL } from 'node:url'

export const DEFAULT_ORIGIN = 'https://maskin.io'
const TIMEOUT_MS = 15_000

export function envPrefix(vendor) {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(vendor)) throw new Error(`"${vendor}" is not a provider name`)
	return vendor.toUpperCase().replace(/-/g, '_')
}

/** The last two labels of a host: the vendor's own domain, so mcp.notion.com and notion.com match. */
function ownDomain(host) {
	return host.split('.').slice(-2).join('.')
}

const AUTH_METHODS = ['client_secret_post', 'client_secret_basic', 'none']

export function parseArgs(argv) {
	const origins = []
	const rest = []
	let authMethod
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--origin') origins.push(argv[++i])
		else if (argv[i] === '--auth-method') authMethod = argv[++i]
		else rest.push(argv[i])
	}
	if (rest.length !== 2)
		throw new Error(
			'usage: register-oauth-client.mjs <vendor> <metadata-url> [--origin <url>]... [--auth-method <method>]',
		)
	if (authMethod !== undefined && !AUTH_METHODS.includes(authMethod)) {
		throw new Error(`--auth-method must be one of ${AUTH_METHODS.join(', ')}`)
	}
	const [vendor, metadataUrl] = rest
	envPrefix(vendor)
	return { vendor, metadataUrl, origins: origins.length ? origins : [DEFAULT_ORIGIN], authMethod }
}

export function callbackUrls(vendor, origins) {
	return origins.map((origin) => {
		const url = new URL(origin)
		if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
			throw new Error(`origin ${origin} must be https`)
		}
		return `${url.origin}/api/integrations/${vendor}/callback`
	})
}

/** Throws unless the published details are safe to register against. Returns the registration URL. */
export function checkMetadata(metadataUrl, metadata) {
	const source = new URL(metadataUrl)
	if (source.protocol !== 'https:') throw new Error('the sign-in details address must be https')
	const endpoint = new URL(String(metadata?.registration_endpoint ?? ''))
	if (endpoint.protocol !== 'https:') throw new Error('the registration address must be https')
	if (ownDomain(endpoint.hostname) !== ownDomain(source.hostname)) {
		throw new Error(
			`the registration address (${endpoint.hostname}) is not on the vendor's own domain (${source.hostname})`,
		)
	}
	const issuer = new URL(String(metadata?.issuer ?? ''))
	if (ownDomain(issuer.hostname) !== ownDomain(source.hostname)) {
		throw new Error(
			`the issuer (${issuer.hostname}) is not on the vendor's own domain (${source.hostname})`,
		)
	}
	return endpoint.toString()
}

/**
 * client_secret_post when the vendor offers it, else client_secret_basic (set tokenAuthMethod in
 * the vendor file to match), else 'none' (a public client with PKCE and no secret, which the
 * sign-in handler supports with tokenAuthMethod 'none'). Refuses anything else.
 */
export function chooseAuthMethod(metadata) {
	const offered = metadata?.token_endpoint_auth_methods_supported
	if (!Array.isArray(offered) || offered.includes('client_secret_post')) return 'client_secret_post'
	if (offered.includes('client_secret_basic')) return 'client_secret_basic'
	if (offered.includes('none')) return 'none'
	throw new Error(
		`the vendor offers none of client_secret_post, client_secret_basic or none (offers: ${offered.join(', ')}); the sign-in handler supports only those`,
	)
}

export function registrationBody(redirectUris, authMethod) {
	return {
		client_name: 'Maskin',
		redirect_uris: redirectUris,
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		token_endpoint_auth_method: authMethod,
	}
}

export function settingsLines(vendor, registration, authMethod = 'client_secret_post') {
	if (typeof registration?.client_id !== 'string' || !registration.client_id) {
		throw new Error('the registration answered without a client id')
	}
	const prefix = envPrefix(vendor)
	// A vendor can answer with a public client (no secret) even when a secret method was asked for
	// (Amplitude), so no secret is not an error: print the id and say so on stderr in main.
	if (
		authMethod === 'none' ||
		typeof registration.client_secret !== 'string' ||
		!registration.client_secret
	) {
		return `${prefix}_CLIENT_ID=${registration.client_id}\n`
	}
	return `${prefix}_CLIENT_ID=${registration.client_id}\n${prefix}_CLIENT_SECRET=${registration.client_secret}\n`
}

async function getJson(url, init, what, fetchImpl) {
	const res = await fetchImpl(url, {
		...init,
		redirect: 'manual',
		signal: AbortSignal.timeout(TIMEOUT_MS),
	})
	if (!res.ok) {
		// The status only: a vendor's error body can echo what we sent.
		throw new Error(`${what} answered ${res.status}`)
	}
	return res.json()
}

export async function main(argv, io = {}) {
	const out = io.stdout ?? ((s) => process.stdout.write(s))
	const err = io.stderr ?? ((s) => process.stderr.write(s))
	const fetchImpl = io.fetch ?? fetch
	try {
		const { vendor, metadataUrl, origins, authMethod: requested } = parseArgs(argv)
		const redirectUris = callbackUrls(vendor, origins)
		const metadata = await getJson(metadataUrl, {}, 'the sign-in details address', fetchImpl)
		const registrationUrl = checkMetadata(metadataUrl, metadata)
		const authMethod = requested ?? chooseAuthMethod(metadata)
		err(`Registering Maskin for ${vendor} at ${new URL(registrationUrl).host} (${authMethod})\n`)
		for (const uri of redirectUris) err(`  callback ${uri}\n`)
		const registration = await getJson(
			registrationUrl,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(registrationBody(redirectUris, authMethod)),
			},
			'the registration address',
			fetchImpl,
		)
		const lines = settingsLines(vendor, registration, authMethod)
		out(lines)
		const values = lines.split('\n').filter(Boolean).length === 1 ? 'value' : 'two values'
		err(
			`Registered. Set the ${values} on the server; do not paste ${values === 'value' ? 'it' : 'them'} anywhere else.\n`,
		)
		if (authMethod !== 'none' && values === 'value') {
			err(
				`The vendor answered with no client secret although ${authMethod} was asked for: it issued a public client. Set tokenAuthMethod to 'none' in the vendor file.\n`,
			)
		}
		return 0
	} catch (e) {
		err(`register-oauth-client failed: ${e instanceof Error ? e.message : e}\n`)
		return 1
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = await main(process.argv.slice(2))
}
