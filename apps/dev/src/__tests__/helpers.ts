/**
 * Request builder helpers for route tests.
 */

export function jsonRequest(
	method: string,
	path: string,
	body?: unknown,
	headers?: Record<string, string>,
) {
	return new Request(`http://localhost${path}`, {
		method,
		headers: {
			'Content-Type': 'application/json',
			...headers,
		},
		body: body ? JSON.stringify(body) : undefined,
	})
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
