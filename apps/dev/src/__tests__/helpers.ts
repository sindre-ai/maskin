/**
 * Request builder helpers for route tests.
 */

export function jsonRequest(
	method: string,
	path: string,
	body?: unknown,
	headers?: Record<string, string>,
	options?: { remoteAddress?: string },
) {
	const req = new Request(`http://localhost${path}`, {
		method,
		headers: {
			'Content-Type': 'application/json',
			...headers,
		},
		body: body ? JSON.stringify(body) : undefined,
	})
	if (options?.remoteAddress) {
		;(req as unknown as { remoteAddress: string }).remoteAddress = options.remoteAddress
	}
	return req
}

export function jsonGet(path: string, headers?: Record<string, string>) {
	return new Request(`http://localhost${path}`, {
		method: 'GET',
		headers: {
			...headers,
		},
	})
}

export function jsonDelete(path: string, headers?: Record<string, string>) {
	return new Request(`http://localhost${path}`, {
		method: 'DELETE',
		headers: {
			...headers,
		},
	})
}

/**
 * Decode a `triggers.metadata` write built by `lib/trigger-metadata.ts`.
 *
 * Those writers emit a Drizzle `SQL` expression (a single-statement jsonb
 * merge) rather than a plain object, so a mock-DB test cannot read
 * `updateSet.metadata.some_key` directly. This pulls the key — and, for the
 * set form, the JSON-encoded value — back out of the query chunks so unit
 * tests can still assert *intent*.
 *
 * It deliberately does not assert the merge is correct: whether
 * `|| jsonb_build_object(...)` actually preserves sibling keys is a Postgres
 * semantic, and only the integration test
 * (`integration/slack-trigger-metadata.test.ts`) can prove that.
 */
export function readMetadataSql(metadata: unknown): { key: string; value?: unknown } {
	const chunks = (metadata as { queryChunks?: unknown[] } | undefined)?.queryChunks
	if (!Array.isArray(chunks)) {
		throw new Error('readMetadataSql: expected a Drizzle SQL expression, got a plain value')
	}
	const params = chunks.filter((c): c is string => typeof c === 'string')
	const [key, encoded] = params
	return encoded === undefined ? { key } : { key, value: JSON.parse(encoded) }
}
