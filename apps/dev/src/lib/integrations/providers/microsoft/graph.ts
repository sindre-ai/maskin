export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

/** Microsoft's code when a tenant admin has not switched on Graph access to transcripts. */
export const TRANSCRIPTS_DISABLED_CODE = 'GraphAccessToTranscriptsDisabled'

const MAX_ATTEMPTS = 3
const BASE_BACKOFF_MS = 1_000
const RETRYABLE = new Set([429, 502, 503, 504])

export class GraphError extends Error {
	constructor(
		readonly status: number,
		/** Graph's top-level error code, e.g. Forbidden. */
		readonly code: string,
		/** Graph's inner error code, e.g. GraphAccessToTranscriptsDisabled. */
		readonly innerCode: string | undefined,
		message: string,
	) {
		super(message)
		this.name = 'GraphError'
	}

	/** The tenant admin has not turned on transcript access (403 with the inner code). */
	get isTranscriptsDisabled(): boolean {
		return this.status === 403 && this.innerCode === TRANSCRIPTS_DISABLED_CODE
	}
}

export interface GraphDeps {
	fetch?: typeof fetch
	sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function toGraphError(res: Response): Promise<GraphError> {
	let code = 'Unknown'
	let innerCode: string | undefined
	let message = `Graph request failed with HTTP ${res.status}`
	try {
		const body = (await res.json()) as {
			error?: { code?: string; message?: string; innerError?: { code?: string } }
		}
		code = body.error?.code ?? code
		innerCode = body.error?.innerError?.code
		message = body.error?.message ?? message
	} catch {
		// Not JSON; the status is all there is.
	}
	return new GraphError(res.status, code, innerCode, message)
}

/**
 * GET against Graph with a bearer token. Retries throttling (429) and gateway
 * errors with backoff, honouring Retry-After. Anything else non-2xx throws a
 * GraphError.
 */
async function graphGet(
	url: string,
	accessToken: string,
	headers: Record<string, string>,
	deps: GraphDeps,
): Promise<Response> {
	const doFetch = deps.fetch ?? fetch
	const sleep = deps.sleep ?? defaultSleep
	for (let attempt = 1; ; attempt++) {
		const res = await doFetch(url, {
			headers: { Authorization: `Bearer ${accessToken}`, ...headers },
		})
		if (res.ok) return res
		if (!RETRYABLE.has(res.status) || attempt >= MAX_ATTEMPTS) throw await toGraphError(res)
		const retryAfter = Number(res.headers.get('Retry-After'))
		await sleep(
			Number.isFinite(retryAfter) && retryAfter > 0
				? Math.min(retryAfter, 30) * 1_000
				: BASE_BACKOFF_MS * 2 ** (attempt - 1),
		)
	}
}

export async function graphJson<T>(
	url: string,
	accessToken: string,
	deps: GraphDeps = {},
	headers: Record<string, string> = {},
): Promise<T> {
	const res = await graphGet(url, accessToken, { Accept: 'application/json', ...headers }, deps)
	return (await res.json()) as T
}

export async function graphText(
	url: string,
	accessToken: string,
	accept: string,
	deps: GraphDeps = {},
): Promise<string> {
	const res = await graphGet(url, accessToken, { Accept: accept }, deps)
	return res.text()
}

/** Every page of a Graph collection, following @odata.nextLink up to maxPages. */
export async function graphPages<T>(
	url: string,
	accessToken: string,
	deps: GraphDeps = {},
	headers: Record<string, string> = {},
	maxPages = 10,
): Promise<T[]> {
	const out: T[] = []
	let next: string | undefined = url
	for (let page = 0; next && page < maxPages; page++) {
		const body: { value?: T[]; '@odata.nextLink'?: string } = await graphJson(
			next,
			accessToken,
			deps,
			headers,
		)
		out.push(...(body.value ?? []))
		next = body['@odata.nextLink']
	}
	return out
}

/**
 * POST a JSON body to Graph. Never retried: a gateway error can arrive after Graph already
 * created the item, and a second attempt would make a duplicate. Non-2xx throws a GraphError.
 */
export async function graphPostJson<T>(
	url: string,
	accessToken: string,
	body: unknown,
	deps: GraphDeps = {},
): Promise<T> {
	const doFetch = deps.fetch ?? fetch
	const res = await doFetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	})
	if (!res.ok) throw await toGraphError(res)
	return (await res.json()) as T
}

/**
 * POST to a Graph action that answers 202 with no body (sendMail). Never retried, for the reason
 * above and worse: a repeat would send the message twice. Non-2xx throws a GraphError; a failure
 * before any answer (network, timeout) throws whatever fetch threw, and the caller must treat
 * that as "may have been sent".
 */
export async function graphPostAction(
	url: string,
	accessToken: string,
	body: unknown,
	deps: GraphDeps = {},
): Promise<void> {
	const doFetch = deps.fetch ?? fetch
	const res = await doFetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	})
	if (!res.ok) throw await toGraphError(res)
}

/**
 * PATCH a JSON body to Graph and return the updated item. Never retried, so a gateway error
 * cannot apply an edit twice. Non-2xx throws a GraphError.
 */
export async function graphPatchJson<T>(
	url: string,
	accessToken: string,
	body: unknown,
	deps: GraphDeps = {},
): Promise<T> {
	const doFetch = deps.fetch ?? fetch
	const res = await doFetch(url, {
		method: 'PATCH',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	})
	if (!res.ok) throw await toGraphError(res)
	return (await res.json()) as T
}

/** DELETE one Graph item (answers 204). Never retried. Non-2xx throws a GraphError. */
export async function graphDelete(
	url: string,
	accessToken: string,
	deps: GraphDeps = {},
): Promise<void> {
	const doFetch = deps.fetch ?? fetch
	const res = await doFetch(url, {
		method: 'DELETE',
		headers: { Authorization: `Bearer ${accessToken}` },
	})
	if (!res.ok) throw await toGraphError(res)
}

/**
 * PUT text to a drive item's content address (a simple upload). Never retried: a gateway error
 * can arrive after the file was written, and a second attempt would rewrite it. Non-2xx throws a
 * GraphError.
 */
export async function graphPutText<T>(
	url: string,
	accessToken: string,
	text: string,
	deps: GraphDeps = {},
): Promise<T> {
	const doFetch = deps.fetch ?? fetch
	const res = await doFetch(url, {
		method: 'PUT',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/json',
			'Content-Type': 'text/plain',
		},
		body: text,
	})
	if (!res.ok) throw await toGraphError(res)
	return (await res.json()) as T
}
