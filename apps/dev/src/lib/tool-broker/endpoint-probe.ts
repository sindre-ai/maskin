import { logger } from '../logger'

// ---------------------------------------------------------------------------
// Ask a URL what it is, before registering it as an integration.
//
// Without this, add-by-URL accepts anything. A documentation page registers
// happily and the failure surfaces two steps later at Connect, as a 400 that
// says nothing about the real problem — the URL was never a server. The same
// mistake reached the catalogue: four synced entries pointed at
// `.well-known/mcp/server-card.json`, which is a metadata document.
//
// The probe also decides how to authenticate, because the server is the
// authority on that and guessing has already cost us twice: every MCP
// integration was registered as OAuth regardless, so an API-keyed server got an
// OAuth button that could not work.
// ---------------------------------------------------------------------------

/** What a URL turned out to be. */
export type EndpointProbe =
	| { kind: 'mcp'; auth: 'none' | 'api_key' | 'oauth2' }
	/** Reachable, but not an MCP server — a docs page, a metadata document, a 404. */
	| { kind: 'not-mcp'; status: number }
	| { kind: 'unreachable' }

const INITIALIZE = JSON.stringify({
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: {
		protocolVersion: '2024-11-05',
		capabilities: {},
		clientInfo: { name: 'maskin', version: '1' },
	},
})

/**
 * A 200 is not enough on its own.
 *
 * A site that serves an SPA shell for every path answers 200 with HTML to any
 * POST, so accepting status alone would let exactly the docs-page mistake back
 * in. The response has to actually look like an `initialize` result — which is
 * carried either as plain JSON or inside an SSE `data:` frame.
 */
const looksLikeInitializeResult = (body: string): boolean =>
	/"protocolVersion"|"serverInfo"/.test(body)

/**
 * Where a server publishes OAuth metadata, per RFC 9728.
 *
 * Its presence is what separates "wants OAuth" from "wants an API key": both
 * answer 401, and only this tells them apart.
 */
const oauthMetadataPaths = [
	'/.well-known/oauth-protected-resource',
	'/.well-known/oauth-authorization-server',
]

const hasOAuthMetadata = async (
	endpoint: URL,
	fetchImpl: typeof fetch,
	timeoutMs: number,
): Promise<boolean> => {
	for (const path of oauthMetadataPaths) {
		try {
			const res = await fetchImpl(new URL(path, endpoint.origin).toString(), {
				signal: AbortSignal.timeout(timeoutMs),
			})
			if (res.ok) return true
		} catch {
			// A metadata endpoint that does not answer is not evidence of OAuth.
		}
	}
	return false
}

/**
 * Probe `url` and report what it is.
 *
 * Never throws: an unreachable host is an answer, not an exception, and the
 * caller turns each outcome into its own message.
 */
export const probeEndpoint = async (
	url: string,
	options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<EndpointProbe> => {
	const fetchImpl = options.fetchImpl ?? fetch
	const timeoutMs = options.timeoutMs ?? 10_000

	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		return { kind: 'unreachable' }
	}

	let res: Response
	try {
		res = await fetchImpl(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
			},
			body: INITIALIZE,
			signal: AbortSignal.timeout(timeoutMs),
		})
	} catch (error) {
		logger.info('Tool broker endpoint probe could not reach the URL', {
			host: parsed.hostname,
			error: error instanceof Error ? error.message : String(error),
		})
		return { kind: 'unreachable' }
	}

	if (res.status === 401 || res.status === 403) {
		// It is a server, and it wants a credential. Which kind is the question.
		return {
			kind: 'mcp',
			auth: (await hasOAuthMetadata(parsed, fetchImpl, timeoutMs)) ? 'oauth2' : 'api_key',
		}
	}

	if (res.status !== 200) return { kind: 'not-mcp', status: res.status }

	const body = await res.text().catch(() => '')
	if (!looksLikeInitializeResult(body)) return { kind: 'not-mcp', status: 200 }

	return { kind: 'mcp', auth: 'none' }
}
