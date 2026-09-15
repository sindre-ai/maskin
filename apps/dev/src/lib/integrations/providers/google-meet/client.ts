import { classifyGoogleApiError, MeetToolError } from './errors'

export interface MeetFetchInit {
	method?: 'GET' | 'POST' | 'DELETE'
	body?: unknown
	query?: Record<string, string | undefined>
}

/**
 * Thin fetch wrapper for Google Meet REST v2 + Workspace Events + People. Maps
 * non-2xx responses to the normalized MeetToolError envelope (see errors.ts)
 * so Google's raw JSON never leaks past this layer.
 */
export async function callGoogleApi<T>(
	url: string,
	accessToken: string,
	init: MeetFetchInit = {},
): Promise<T> {
	const method = init.method ?? 'GET'
	const target = new URL(url)
	if (init.query) {
		for (const [k, v] of Object.entries(init.query)) {
			if (v === undefined) continue
			target.searchParams.set(k, v)
		}
	}

	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
	}
	let body: BodyInit | undefined
	if (init.body !== undefined) {
		headers['Content-Type'] = 'application/json'
		body = JSON.stringify(init.body)
	}

	const res = await fetch(target.toString(), { method, headers, body })
	if (!res.ok) {
		const raw = await res.text().catch(() => '')
		throw classifyGoogleApiError(res.status, raw, res.headers.get('retry-after') ?? undefined)
	}
	if (res.status === 204) return undefined as unknown as T
	return (await res.json()) as T
}

/** Serialize a MeetToolError for MCP tool responses; rethrow anything else. */
export function toolErrorPayload(
	err: unknown,
): { isError: true; content: [{ type: 'text'; text: string }] } {
	if (err instanceof MeetToolError) {
		return {
			isError: true as const,
			content: [{ type: 'text' as const, text: JSON.stringify(err.envelope) }],
		}
	}
	throw err
}
