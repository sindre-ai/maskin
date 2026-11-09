import { type Server, createServer } from 'node:http'
import { createTestActor } from './api.helper'

/**
 * Fixtures for the Claude connector consent page (mcp-oauth-consent.spec.ts).
 *
 * The preview, approve and deny routes answer 403 unless the person is a flag tester, and the
 * tester list is read from the server's environment at boot. So the actors the spec signs in as
 * have fixed ids, listed in playwright.config.ts (FF_TESTER_ACTOR_IDS) next to the switch and the
 * flag. A spec signs in as one of them with ensureOauthActor.
 */
export const E2E_OAUTH_ACTORS = {
	/** Has exactly one workspace. */
	single: {
		id: '11111111-1111-4111-8111-111111111111',
		email: 'e2e-oauth-single@test.invalid',
	},
	/** Has two workspaces (the spec adds the second). */
	multi: {
		id: '22222222-2222-4222-8222-222222222222',
		email: 'e2e-oauth-multi@test.invalid',
	},
} as const

export const E2E_OAUTH_PASSWORD = 'e2e-test-password-123'

/** The origin the server advertises as issuer and resource: the web app the specs drive. */
export const E2E_OAUTH_ISSUER = 'http://localhost:5173'

/**
 * The API server itself. The web dev and preview servers only proxy /api and /mcp, so the token
 * endpoint and the discovery documents (served by the API server, at the root) are reached here.
 */
export const E2E_OAUTH_API_ORIGIN = 'http://localhost:3000'

/** Where the dev server sends PostHog events during the run (POSTHOG_HOST in playwright.config.ts). */
export const E2E_OAUTH_CAPTURE_PORT = 4011

export const E2E_OAUTH_CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata'
export const E2E_OAUTH_CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
export const E2E_OAUTH_STATE = 'e2e-state-0123456789'

/** The parameters Claude sends to /oauth/authorize, valid against the pinned client record. */
export function authorizeParams(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		response_type: 'code',
		client_id: E2E_OAUTH_CLIENT_ID,
		redirect_uri: E2E_OAUTH_CALLBACK,
		code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
		code_challenge_method: 'S256',
		state: E2E_OAUTH_STATE,
		resource: `${E2E_OAUTH_ISSUER}/mcp`,
		...overrides,
	}
}

/** The PKCE verifier whose S256 challenge is the one in authorizeParams (the RFC 7636 example). */
const CODE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'

/**
 * Connects Claude to a workspace the way Claude does: approve (what Allow on the consent page
 * calls), then swap the one-time code for tokens. A connection only counts, and only appears in the
 * list, once the swap has happened.
 */
export async function connectClaude(actor: OauthActor, workspaceId: string): Promise<void> {
	const approved = await fetch(`${E2E_OAUTH_ISSUER}/api/oauth/authorize/approve`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${actor.apiKey}` },
		body: JSON.stringify({ ...authorizeParams(), workspace_id: workspaceId }),
	})
	if (!approved.ok) throw new Error(`approve failed: ${approved.status}`)
	const { redirect_url } = (await approved.json()) as { redirect_url: string }
	const code = new URL(redirect_url).searchParams.get('code') ?? ''

	const exchanged = await fetch(`${E2E_OAUTH_API_ORIGIN}/oauth/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: E2E_OAUTH_CALLBACK,
			client_id: E2E_OAUTH_CLIENT_ID,
			code_verifier: CODE_VERIFIER,
			resource: `${E2E_OAUTH_ISSUER}/mcp`,
		}),
	})
	if (!exchanged.ok) throw new Error(`token exchange failed: ${exchanged.status}`)
}

/** Ends every Claude connection the actor has, so a test starts from Not connected. */
export async function disconnectAll(actor: OauthActor): Promise<void> {
	const headers = { Authorization: `Bearer ${actor.apiKey}` }
	const list = await fetch(`${E2E_OAUTH_ISSUER}/api/oauth/grants`, { headers })
	const grants = (await list.json()) as Array<{ id: string }>
	for (const grant of grants) {
		await fetch(`${E2E_OAUTH_ISSUER}/api/oauth/grants/${grant.id}`, { method: 'DELETE', headers })
	}
}

export interface OauthActor {
	id: string
	name: string
	email: string
	apiKey: string
}

/** Creates the fixed-id actor, or signs it in when an earlier test (or retry) already did. */
export async function ensureOauthActor(which: keyof typeof E2E_OAUTH_ACTORS): Promise<OauthActor> {
	const { id, email } = E2E_OAUTH_ACTORS[which]
	const name = `E2E OAuth ${which}`
	try {
		const created = await createTestActor({ name, email, password: E2E_OAUTH_PASSWORD, id })
		return { id, name, email, apiKey: created.api_key }
	} catch {
		const res = await fetch(`${E2E_OAUTH_ISSUER}/api/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email, password: E2E_OAUTH_PASSWORD }),
		})
		if (!res.ok) throw new Error(`ensureOauthActor(${which}) could not sign in: ${res.status}`)
		const body = (await res.json()) as { api_key: string; name: string }
		return { id, name: body.name, email, apiKey: body.api_key }
	}
}

export interface CaptureStub {
	/** Event names received since the last clear, in order. */
	events: () => string[]
	clear: () => void
	close: () => Promise<void>
}

/** A stand-in for PostHog's ingestion endpoint, so the funnel events the server sends can be read back. */
export async function startCaptureStub(): Promise<CaptureStub> {
	const received: string[] = []
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on('data', (chunk) => chunks.push(chunk))
		req.on('end', () => {
			try {
				const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
				if (typeof body.event === 'string') received.push(body.event)
			} catch {
				// Not an event body: ignore.
			}
			res.writeHead(200, { 'Content-Type': 'application/json' })
			res.end('{"status":1}')
		})
	})
	await new Promise<void>((resolve) => server.listen(E2E_OAUTH_CAPTURE_PORT, resolve))
	return {
		events: () => [...received],
		clear: () => {
			received.length = 0
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	}
}
