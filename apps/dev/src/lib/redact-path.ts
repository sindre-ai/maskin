const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `DELETE /api/devices/{id_or_token}` accepts a raw APNs token in the path.
 * Anything that logs a request path must not record it. A uuid (the device id)
 * is kept; any other segment after `/api/devices/` is replaced.
 */
export function redactPath(path: string): string {
	return path.replace(/(\/api\/devices\/)([^/?\s]+)/, (_m, prefix: string, seg: string) =>
		UUID_SEGMENT.test(seg) ? `${prefix}${seg}` : `${prefix}:token`,
	)
}

/** Redacts the path inside a `hono/logger` line (`--> DELETE /path 200 3ms`). */
export function redactLogLine(line: string): string {
	return redactPath(line)
}
