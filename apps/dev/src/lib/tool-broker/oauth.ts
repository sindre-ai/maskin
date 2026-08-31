import { type OAuthMetadata, type ToolBrokerClient, ToolBrokerHttpError } from '@maskin/tool-broker'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { decodeState, encodeState } from '../integrations/oauth/state'
import { logger } from '../logger'

// ---------------------------------------------------------------------------
// OAuth for tool-broker integrations.
//
// THE SHAPE, and why it keeps the backend private. `oauth/start` accepts OUR
// redirect URI and `oauth/complete` takes `{state, code}` server to server, so:
//
//   1. we ask the backend to start   -> it returns the provider's authorize URL
//   2. the browser visits THE PROVIDER — never the backend
//   3. the provider redirects to OUR callback
//   4. we hand the code back to the backend over the wire
//
// The backend therefore needs no public exposure at all, and PKCE stays its
// problem rather than ours (it mints the challenge and holds the verifier).
//
// CORRELATION. The backend generates its own `state` and embeds it in the
// authorize URL, so we cannot substitute ours. What we need at callback time is
// which workspace, actor and integration a returning `state` belongs to. That
// binding rides in a short-lived encrypted cookie rather than a table: the
// callback is a top-level browser navigation from the provider, so the cookie is
// present, and this is the same mechanism the existing provider OAuth uses.
// ---------------------------------------------------------------------------

const COOKIE_NAME = 'tb_oauth'
/** Long enough for a consent screen, short enough that an abandoned flow expires. */
const COOKIE_MAX_AGE = 10 * 60
export const CALLBACK_PATH = '/api/tool-broker/oauth/callback'

export interface ToolBrokerOAuthBinding {
	workspaceId: string
	actorId: string
	integrationSlug: string
	/**
	 * The state AS IT APPEARS IN THE AUTHORIZE URL — an envelope the backend
	 * wraps around its own state — which is what the provider echoes back and
	 * therefore what we compare against.
	 */
	brokerState: string
	/**
	 * The backend's RAW state, as its start response returned it.
	 *
	 * These are two different strings and each is only accepted in one place:
	 * comparing against the raw value fails every callback, and completing with
	 * the envelope answers 404 because the backend cannot find that state.
	 */
	completeState: string
	scope: 'workspace' | 'personal'
	ts: number
	nonce: string
}

/** Our callback URL, as the provider must be told to redirect to. */
export const callbackUrl = (publicOrigin: string): string =>
	`${publicOrigin.replace(/\/+$/, '')}${CALLBACK_PATH}`

export const bindOAuthFlow = (
	c: Context,
	binding: Omit<ToolBrokerOAuthBinding, 'ts' | 'nonce'>,
	secure: boolean,
): void => {
	const payload: ToolBrokerOAuthBinding = {
		...binding,
		ts: Date.now(),
		nonce: Math.random().toString(36).slice(2),
	}
	setCookie(c, COOKIE_NAME, encodeState(payload as never), {
		httpOnly: true,
		// Lax, not Strict: the callback is a top-level GET navigation from the
		// provider's domain, which Strict would drop — silently breaking every
		// connect. Same reasoning as the provider OAuth cookie.
		sameSite: 'Lax',
		secure,
		path: '/api/tool-broker',
		maxAge: COOKIE_MAX_AGE,
	})
}

/**
 * Read and validate the binding for a returning `state`.
 *
 * Returns null on anything suspicious — missing cookie, undecodable payload,
 * expiry, or a state that does not match the one we started. The caller renders
 * the same failure for all of them; distinguishing would let a caller probe.
 */
export const readOAuthBinding = (
	c: Context,
	returnedState: string,
): ToolBrokerOAuthBinding | null => {
	const raw = getCookie(c, COOKIE_NAME)
	if (!raw) return null

	let binding: ToolBrokerOAuthBinding
	try {
		binding = decodeState<ToolBrokerOAuthBinding>(raw)
	} catch {
		return null
	}

	if (!binding.brokerState || binding.brokerState !== returnedState) return null
	if (!Number.isFinite(binding.ts) || Date.now() - binding.ts > COOKIE_MAX_AGE * 1000) return null
	return binding
}

/** Clear the binding so a replay of the same state cannot ride a live cookie. */
export const clearOAuthBinding = (c: Context, secure: boolean): void => {
	setCookie(c, COOKIE_NAME, '', {
		httpOnly: true,
		sameSite: 'Lax',
		secure,
		path: '/api/tool-broker',
		maxAge: 0,
	})
}

/**
 * Get an OAuth client for this integration, registering one dynamically when the
 * provider supports it.
 *
 * DCR is the case worth having: a provider advertising a registration endpoint
 * needs no pre-registered app and no client secret from us, which is what lets
 * the catalogue scale without a developer touching it per vendor. When a
 * provider does not support it, this reports that plainly rather than failing
 * obscurely — connecting it needs a client configured out of band.
 */
export const resolveOAuthClient = async (
	client: ToolBrokerClient,
	apiKey: string,
	input: { integrationSlug: string; endpointUrl: string; redirectUri: string },
): Promise<{ clientId: string; metadata: OAuthMetadata }> => {
	const metadata = await client.probeOAuth(apiKey, input.endpointUrl)
	if (!metadata.registrationEndpoint) {
		throw new OAuthNotSupportedError(input.integrationSlug)
	}

	try {
		const clientId = await client.registerOAuthClient(apiKey, {
			slug: input.integrationSlug,
			metadata,
			redirectUri: input.redirectUri,
			clientName: 'Maskin',
		})
		return { clientId, metadata }
	} catch (error) {
		// Advertising a registration endpoint is not the same as allowing anyone to
		// use it. Meta's Ads server publishes one and then refuses every request
		// with "Dynamic registration is not available for this client" — measured
		// against four different request shapes, so it is their policy rather than
		// something we sent. Presenting that as a bare "returned 400" tells the
		// user nothing they can act on, and the state is exactly the one we already
		// have a name for.
		if (error instanceof ToolBrokerHttpError && error.status === 400) {
			logger.info('Provider advertises dynamic registration but refused it', {
				slug: input.integrationSlug,
				registrationEndpoint: metadata.registrationEndpoint,
			})
			throw new OAuthNotSupportedError(input.integrationSlug)
		}
		throw error
	}
}

/** The provider cannot be connected without a client registered out of band. */
export class OAuthNotSupportedError extends Error {
	constructor(readonly integrationSlug: string) {
		super(
			'This integration does not support automatic OAuth registration. It needs a client configured before it can be connected.',
		)
		this.name = 'OAuthNotSupportedError'
	}
}
