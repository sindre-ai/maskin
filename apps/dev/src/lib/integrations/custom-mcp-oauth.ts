import { lookup } from 'node:dns/promises'
import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { eq, sql } from 'drizzle-orm'
import { decrypt, encrypt } from '../crypto'
import { logger } from '../logger'
import {
	CUSTOM_MCP_PROVIDER,
	type CustomMcpServer,
	isPublicHost,
	readCustomServer,
} from './custom-mcp'
import { createS256CodeChallenge, generateCodeVerifier } from './oauth/pkce'

// A custom MCP server that signs people in with a browser (OAuth with a one-time consent), as
// Dinero's does. A person signs in once; Maskin keeps the token and its refresh token with the
// server's definition (one encrypted blob), refreshes it in the gateway, and sends it upstream.
// The agent never sees it. The sign-in follows the MCP authorization spec: the server answers
// 401 and points at its protected-resource metadata, which names the authorization server,
// which allows open client registration (RFC 7591) and the authorization code flow with PKCE.

const REQUEST_TIMEOUT_MS = 15_000
const MAX_BODY_CHARS = 64 * 1024
/** Renew a token this long before it runs out, so a call never leaves with one about to expire. */
const REFRESH_BUFFER_MS = 2 * 60 * 1000
/** A started sign-in is good for this long, as for the other connect flows. */
export const SIGN_IN_WINDOW_MS = 10 * 60 * 1000

export type AuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic'

/** A finished sign-in: what the gateway needs to call the server and to renew the token. */
export interface StoredSignIn {
	clientId: string
	clientSecret?: string
	authMethod: AuthMethod
	tokenEndpoint: string
	/** The RFC 8707 resource the token was issued for, sent again on refresh. */
	resource?: string
	scope?: string
	accessToken: string
	refreshToken?: string
	/** Epoch ms. Absent when the server gave no lifetime: the token is then used until refused. */
	expiresAt?: number
}

/** A sign-in that was started and not yet finished. Cleared once the callback uses it. */
export interface PendingSignIn {
	nonce: string
	startedAt: number
	/** The server URL the sign-in was started for; a changed URL voids it. */
	serverUrl: string
	redirectUri: string
	codeVerifier: string
	clientId: string
	clientSecret?: string
	authMethod: AuthMethod
	tokenEndpoint: string
	resource?: string
	scope?: string
}

/** The encrypted blob of a custom server row. `server` is the definition, the rest are tokens. */
interface Blob {
	server: unknown
	oauth?: StoredSignIn
	oauth_pending?: PendingSignIn
}

/** Why a sign-in or a renewal failed, in words a person can act on. */
export class SignInError extends Error {
	/** `rejected`: the sign-in is gone and a person has to do it again. `transient`: try again. */
	constructor(
		readonly kind: 'rejected' | 'transient' | 'unsupported',
		message: string,
	) {
		super(message)
		this.name = 'SignInError'
	}
}

// ── Reading and writing the blob ──────────────────────────────────────────

function readBlob(row: { credentials: string | null }): Blob | null {
	if (!row.credentials) return null
	try {
		const parsed = JSON.parse(decrypt(row.credentials)) as Blob
		return parsed && typeof parsed === 'object' ? parsed : null
	} catch {
		return null
	}
}

/** The finished sign-in stored with a custom server, or null when nobody has signed in. */
export function readSignIn(row: { credentials: string | null }): StoredSignIn | null {
	const oauth = readBlob(row)?.oauth
	return oauth && typeof oauth.accessToken === 'string' && oauth.accessToken ? oauth : null
}

/**
 * The blob to save for a changed server definition. The sign-in stays only while the URL is
 * unchanged: a token is a credential for one place, and keeping it after the URL moves would
 * send it somewhere the person never signed in to.
 */
export function blobForServer(
	server: CustomMcpServer,
	previous: { credentials: string | null } | null,
): string {
	const old = previous ? readBlob(previous) : null
	const oldServer = previous ? readCustomServer(previous) : null
	const sameTarget = !!old && !!oldServer && oldServer.url === server.url
	const next: Blob = { server }
	if (sameTarget && old?.oauth) next.oauth = old.oauth
	if (sameTarget && old?.oauth_pending) next.oauth_pending = old.oauth_pending
	return encrypt(JSON.stringify(next))
}

/** Same lock key for every writer of one server's blob, so a refresh and an edit never overlap. */
export async function lockBlob(
	tx: Pick<Database, 'execute'>,
	integrationId: string,
): Promise<void> {
	await tx.execute(
		sql`SELECT pg_advisory_xact_lock(hashtextextended(${`custom-mcp-oauth:${integrationId}`}::text, 0))`,
	)
}

export function withBlobLock<T>(
	db: Database,
	integrationId: string,
	fn: (row: typeof integrations.$inferSelect, tx: Pick<Database, 'update'>) => Promise<T>,
): Promise<T> {
	return db.transaction(async (tx) => {
		await lockBlob(tx, integrationId)
		const [row] = await tx
			.select()
			.from(integrations)
			.where(eq(integrations.id, integrationId))
			.limit(1)
		if (!row) throw new Error(`Tool server ${integrationId} not found`)
		return fn(row, tx)
	})
}

/**
 * Save a changed blob inside the locking transaction. Nothing else is written in it, so the only
 * way to lose it is a failed commit, and a refresh that has spent the old token is then retried
 * from the same stored one.
 */
async function saveBlob(
	tx: Pick<Database, 'update'>,
	integrationId: string,
	blob: Blob,
): Promise<void> {
	await tx
		.update(integrations)
		.set({ credentials: encrypt(JSON.stringify(blob)), updatedAt: new Date() })
		.where(eq(integrations.id, integrationId))
}

// ── Talking to the other side ─────────────────────────────────────────────

/** True when the name resolves only to public addresses. */
export async function resolvesPublicly(host: string): Promise<boolean> {
	try {
		const addrs = await lookup(host, { all: true })
		return addrs.length > 0 && addrs.every((a) => isPublicHost(a.address))
	} catch {
		return false
	}
}

/**
 * One request to an address the server's own pages named. The address is not the person's, so it
 * must be https, resolve to a public address and answer without a redirect. A body is cut short
 * rather than read whole.
 */
async function call(
	url: string,
	init: RequestInit & { headers?: Record<string, string> },
): Promise<{ status: number; text: string; headers: Headers }> {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		throw new SignInError('unsupported', 'The server named an address that is not a URL')
	}
	if (parsed.protocol !== 'https:' || !(await resolvesPublicly(parsed.hostname))) {
		throw new SignInError('unsupported', `Maskin will not call ${parsed.hostname} to sign in`)
	}
	let res: Response
	try {
		res = await fetch(parsed, {
			...init,
			redirect: 'manual',
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
	} catch {
		throw new SignInError('transient', `${parsed.hostname} could not be reached`)
	}
	const text = (await res.text().catch(() => '')).slice(0, MAX_BODY_CHARS)
	return { status: res.status, text, headers: res.headers }
}

function json(text: string): Record<string, unknown> | null {
	try {
		const v = JSON.parse(text) as unknown
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
	} catch {
		return null
	}
}

function str(v: unknown): string | undefined {
	return typeof v === 'string' && v.length > 0 ? v : undefined
}

function strings(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** `key="value"` out of a WWW-Authenticate challenge. */
function challengeParam(header: string | null, key: string): string | undefined {
	if (!header) return undefined
	const m = header.match(new RegExp(`${key}="([^"]*)"`, 'i'))
	return m?.[1] || undefined
}

export interface Discovery {
	authorizationEndpoint: string
	tokenEndpoint: string
	registrationEndpoint: string
	resource: string
	scope?: string
	authMethods: string[]
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
	const res = await call(url, { method: 'GET', headers: { Accept: 'application/json' } })
	return res.status === 200 ? json(res.text) : null
}

/** Finds how to sign in to an MCP server: who issues its tokens and where to register. */
export async function discover(serverUrl: string): Promise<Discovery> {
	const target = new URL(serverUrl)

	// An unauthenticated request is the server's cue to say where its metadata is.
	let challenge: string | null = null
	try {
		const probe = await call(serverUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-03-26',
					capabilities: {},
					clientInfo: { name: 'Maskin', version: '1' },
				},
			}),
		})
		if (probe.status === 401) challenge = probe.headers.get('www-authenticate')
	} catch (err) {
		if (err instanceof SignInError && err.kind === 'unsupported') throw err
		// An unreachable probe still leaves the well-known addresses to try below.
	}

	const path = target.pathname.replace(/\/$/, '')
	const prmCandidates = [
		challengeParam(challenge, 'resource_metadata'),
		`${target.origin}/.well-known/oauth-protected-resource${path}`,
		`${target.origin}/.well-known/oauth-protected-resource`,
	].filter((u): u is string => !!u)
	let prm: Record<string, unknown> | null = null
	for (const url of prmCandidates) {
		prm = await getJson(url).catch(() => null)
		if (prm) break
	}

	let issuer: URL
	try {
		issuer = new URL(strings(prm?.authorization_servers)[0] ?? target.origin)
	} catch {
		throw new SignInError('unsupported', 'The server names a sign-in service that is not a URL')
	}
	const issuerPath = issuer.pathname.replace(/\/$/, '')
	const asCandidates = [
		`${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`,
		`${issuer.origin}/.well-known/openid-configuration${issuerPath}`,
		`${issuer.origin}${issuerPath}/.well-known/openid-configuration`,
	]
	let meta: Record<string, unknown> | null = null
	for (const url of asCandidates) {
		meta = await getJson(url).catch(() => null)
		if (meta) break
	}
	const authorizationEndpoint = str(meta?.authorization_endpoint)
	const tokenEndpoint = str(meta?.token_endpoint)
	if (!meta || !authorizationEndpoint || !tokenEndpoint) {
		throw new SignInError(
			'unsupported',
			'This server does not say how to sign in. It may need a key in a header instead',
		)
	}
	for (const endpoint of [authorizationEndpoint, tokenEndpoint, str(meta.registration_endpoint)]) {
		if (endpoint && !endpoint.startsWith('https://')) {
			throw new SignInError('unsupported', 'This server names a sign-in address that is not https')
		}
	}
	const registrationEndpoint = str(meta.registration_endpoint)
	if (!registrationEndpoint) {
		throw new SignInError(
			'unsupported',
			'This server does not allow an app to register itself, so it needs a client registered by hand',
		)
	}
	const methods = strings(meta.code_challenge_methods_supported)
	if (methods.length > 0 && !methods.includes('S256')) {
		throw new SignInError('unsupported', 'This server does not support the sign-in Maskin uses')
	}

	// The resource the token is for. Only a value on the server's own origin is taken from its
	// metadata; anything else would let that metadata name a different audience.
	let resource = target.origin + path
	const declared = str(prm?.resource)
	if (declared) {
		try {
			if (new URL(declared).origin === target.origin) resource = declared
		} catch {
			// A bad value is ignored; the server URL is the resource.
		}
	}

	// Scopes: what the server asked for, else what its metadata lists, plus offline_access where
	// the issuer offers it, because that is what yields a refresh token.
	const asked = (challengeParam(challenge, 'scope') ?? '').split(/\s+/).filter(Boolean)
	const listed = asked.length > 0 ? asked : strings(prm?.scopes_supported)
	const scopes = new Set(listed)
	if (strings(meta.scopes_supported).includes('offline_access')) scopes.add('offline_access')

	return {
		authorizationEndpoint,
		tokenEndpoint,
		registrationEndpoint,
		resource,
		scope: scopes.size > 0 ? [...scopes].join(' ') : undefined,
		authMethods: strings(meta.token_endpoint_auth_methods_supported),
	}
}

async function register(
	found: Discovery,
	redirectUri: string,
): Promise<{ clientId: string; clientSecret?: string; authMethod: AuthMethod }> {
	// A public client proving itself with PKCE where the server allows it.
	const wanted: AuthMethod =
		found.authMethods.length === 0 || found.authMethods.includes('none')
			? 'none'
			: found.authMethods.includes('client_secret_post')
				? 'client_secret_post'
				: 'client_secret_basic'
	const res = await call(found.registrationEndpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
		body: JSON.stringify({
			client_name: 'Maskin',
			redirect_uris: [redirectUri],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: wanted,
			...(found.scope ? { scope: found.scope } : {}),
		}),
	})
	const body = json(res.text)
	const clientId = str(body?.client_id)
	if (res.status >= 500) throw new SignInError('transient', 'The server could not register Maskin')
	if (res.status < 200 || res.status > 299 || !clientId) {
		throw new SignInError('unsupported', 'The server refused to register Maskin as an app')
	}
	const granted = str(body?.token_endpoint_auth_method)
	const authMethod: AuthMethod =
		granted === 'client_secret_basic' || granted === 'client_secret_post' || granted === 'none'
			? granted
			: wanted
	return { clientId, clientSecret: str(body?.client_secret), authMethod }
}

// ── Sign-in ───────────────────────────────────────────────────────────────

/**
 * Starts a sign-in: finds the server's sign-in, registers Maskin with it and keeps what the
 * callback will need. Returns the address a person opens in a browser.
 */
export async function startSignIn(
	db: Database,
	input: {
		integrationId: string
		server: CustomMcpServer
		redirectUri: string
		/** One-time value that binds the callback to this sign-in and this browser. */
		nonce: string
		/** The sealed state to send out and get back: it carries the nonce. */
		state: string
	},
): Promise<string> {
	const { integrationId, server, redirectUri, nonce } = input
	if (!server.url) throw new SignInError('unsupported', 'This server has no URL to sign in to')
	const found = await discover(server.url)
	const client = await register(found, redirectUri)
	const codeVerifier = generateCodeVerifier()

	const pending: PendingSignIn = {
		nonce,
		startedAt: Date.now(),
		serverUrl: server.url,
		redirectUri,
		codeVerifier,
		clientId: client.clientId,
		clientSecret: client.clientSecret,
		authMethod: client.authMethod,
		tokenEndpoint: found.tokenEndpoint,
		resource: found.resource,
		scope: found.scope,
	}
	await withBlobLock(db, integrationId, async (row, tx) => {
		const blob = readBlob(row)
		if (!blob) throw new Error('Tool server definition is unreadable')
		await saveBlob(tx, integrationId, { ...blob, oauth_pending: pending })
	})

	const url = new URL(found.authorizationEndpoint)
	url.searchParams.set('response_type', 'code')
	url.searchParams.set('client_id', client.clientId)
	url.searchParams.set('redirect_uri', redirectUri)
	url.searchParams.set('state', input.state)
	url.searchParams.set('code_challenge', createS256CodeChallenge(codeVerifier))
	url.searchParams.set('code_challenge_method', 'S256')
	if (found.scope) url.searchParams.set('scope', found.scope)
	url.searchParams.set('resource', found.resource)
	return url.toString()
}

interface TokenReply {
	accessToken: string
	refreshToken?: string
	expiresAt?: number
	scope?: string
}

async function tokenRequest(
	tokenEndpoint: string,
	client: { clientId: string; clientSecret?: string; authMethod: AuthMethod },
	params: Record<string, string>,
): Promise<TokenReply> {
	const body = new URLSearchParams(params)
	const headers: Record<string, string> = {
		'Content-Type': 'application/x-www-form-urlencoded',
		Accept: 'application/json',
	}
	if (client.authMethod === 'client_secret_basic' && client.clientSecret) {
		const pair = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`
		headers.Authorization = `Basic ${Buffer.from(pair).toString('base64')}`
	} else {
		body.set('client_id', client.clientId)
		if (client.authMethod === 'client_secret_post' && client.clientSecret) {
			body.set('client_secret', client.clientSecret)
		}
	}
	const res = await call(tokenEndpoint, { method: 'POST', headers, body: body.toString() })
	const reply = json(res.text)
	if (res.status === 400 || res.status === 401 || res.status === 403) {
		// invalid_grant, invalid_client and the like: the grant or the client is gone.
		throw new SignInError('rejected', 'The server refused the sign-in')
	}
	if (res.status < 200 || res.status > 299) {
		throw new SignInError('transient', `The server could not issue a token (${res.status})`)
	}
	const accessToken = str(reply?.access_token)
	if (!accessToken) throw new SignInError('transient', 'The server returned no token')
	const lifetime = typeof reply?.expires_in === 'number' ? reply.expires_in : undefined
	return {
		accessToken,
		refreshToken: str(reply?.refresh_token),
		// No lifetime means no expiry to plan around: the token is used until the server refuses it.
		expiresAt: lifetime !== undefined ? Date.now() + lifetime * 1000 : undefined,
		scope: str(reply?.scope),
	}
}

/**
 * Finishes a sign-in with the code the browser came back with. The pending record is spent
 * first, so the same state cannot be used twice, and it only counts for the server URL it was
 * started for.
 */
export async function completeSignIn(
	db: Database,
	input: { integrationId: string; workspaceId: string; nonce: string; code: string },
): Promise<void> {
	const { integrationId, workspaceId, nonce, code } = input
	// The pending record is spent even when the exchange fails, so the error is thrown only after
	// the transaction that spent it has committed.
	let failure: unknown = null
	await withBlobLock(db, integrationId, async (row, tx) => {
		if (
			row.workspaceId !== workspaceId ||
			row.provider !== CUSTOM_MCP_PROVIDER ||
			row.status !== 'active'
		) {
			failure = new SignInError('rejected', 'Tool server not found')
			return
		}
		const blob = readBlob(row)
		const pending = blob?.oauth_pending
		const server = readCustomServer(row)
		if (!blob || !pending || !server || pending.nonce !== nonce) {
			failure = new SignInError('rejected', 'This sign-in was not started here or was already used')
			return
		}
		const { oauth_pending: _spent, ...rest } = blob
		await saveBlob(tx, integrationId, rest)
		if (Date.now() - pending.startedAt > SIGN_IN_WINDOW_MS) {
			failure = new SignInError('rejected', 'The sign-in took too long. Start it again')
			return
		}
		if (server.url !== pending.serverUrl) {
			failure = new SignInError('rejected', 'The server changed since the sign-in started')
			return
		}
		try {
			const tokens = await tokenRequest(pending.tokenEndpoint, pending, {
				grant_type: 'authorization_code',
				code,
				redirect_uri: pending.redirectUri,
				code_verifier: pending.codeVerifier,
				...(pending.resource ? { resource: pending.resource } : {}),
			})
			await saveBlob(tx, integrationId, {
				...rest,
				oauth: {
					clientId: pending.clientId,
					clientSecret: pending.clientSecret,
					authMethod: pending.authMethod,
					tokenEndpoint: pending.tokenEndpoint,
					resource: pending.resource,
					scope: tokens.scope ?? pending.scope,
					accessToken: tokens.accessToken,
					refreshToken: tokens.refreshToken,
					expiresAt: tokens.expiresAt,
				},
			})
		} catch (err) {
			failure = err
		}
	})
	if (failure) throw failure
}

/** Forgets the sign-in (and any started one). The server's definition stays as it is. */
export async function signOut(db: Database, integrationId: string): Promise<boolean> {
	return withBlobLock(db, integrationId, async (row, tx) => {
		const blob = readBlob(row)
		if (!blob || (!blob.oauth && !blob.oauth_pending)) return false
		const { oauth: _a, oauth_pending: _b, ...rest } = blob
		await saveBlob(tx, integrationId, rest)
		return true
	})
}

// ── The token, as the gateway uses it ─────────────────────────────────────

function stillGood(s: StoredSignIn): boolean {
	return s.expiresAt === undefined || s.expiresAt > Date.now() + REFRESH_BUFFER_MS
}

/**
 * A token that works now, or null when nobody has signed in to this server. Renews it when it is
 * about to run out. One renewal at a time per server, across every process: a refresh token that
 * rotates is spent by its first use, so a second renewal at once would strand the sign-in.
 *
 * Throws SignInError: `rejected` when the sign-in is gone and a person has to do it again,
 * `transient` when the server could not be reached and a retry may work.
 */
export async function getAccessToken(
	db: Database,
	row: typeof integrations.$inferSelect,
): Promise<string | null> {
	const current = readSignIn(row)
	if (!current) return null
	if (stillGood(current)) return current.accessToken

	return withBlobLock(db, row.id, async (locked, tx) => {
		const blob = readBlob(locked)
		const now = blob?.oauth
		if (!blob || !now) return null
		// Another request may have renewed it while this one waited for the lock.
		if (stillGood(now)) return now.accessToken
		if (!now.refreshToken) {
			throw new SignInError('rejected', 'The sign-in has expired and cannot be renewed')
		}
		try {
			const renewed = await tokenRequest(now.tokenEndpoint, now, {
				grant_type: 'refresh_token',
				refresh_token: now.refreshToken,
				...(now.resource ? { resource: now.resource } : {}),
			})
			await saveBlob(tx, row.id, {
				...blob,
				oauth: {
					...now,
					accessToken: renewed.accessToken,
					// A server that rotates sends a new refresh token, and the old one is spent.
					refreshToken: renewed.refreshToken ?? now.refreshToken,
					// Not the old expiry: it is already past and would renew on every call.
					expiresAt: renewed.expiresAt,
					scope: renewed.scope ?? now.scope,
				},
			})
			return renewed.accessToken
		} catch (err) {
			if (err instanceof SignInError && err.kind === 'rejected') {
				logger.warn('Tool server sign-in was refused on renewal', { integrationId: row.id })
			}
			throw err
		}
	})
}
