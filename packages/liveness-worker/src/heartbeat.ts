/**
 * Fetch the fleet-liveness heartbeat and classify the result. Anything that
 * isn't a clean 2xx with a well-shaped body is treated as silence — the point
 * of the bet is to page when the fleet (or the endpoint that reads its state)
 * has stopped answering.
 */

export type HeartbeatBody = {
	latest_completed_at: string | null
	minutes_since: number | null
}

export type HeartbeatResult =
	| { kind: 'ok'; body: HeartbeatBody }
	| { kind: 'non_2xx'; status: number }
	| { kind: 'malformed'; status: number }
	| { kind: 'network_error'; message: string }

export async function fetchHeartbeat(
	url: string,
	sharedSecret: string,
	fetchImpl: typeof fetch = fetch,
): Promise<HeartbeatResult> {
	let res: Response
	try {
		res = await fetchImpl(url, {
			method: 'GET',
			headers: { 'X-Heartbeat-Secret': sharedSecret },
		})
	} catch (err) {
		return { kind: 'network_error', message: err instanceof Error ? err.message : String(err) }
	}

	if (res.status < 200 || res.status >= 300) {
		return { kind: 'non_2xx', status: res.status }
	}

	let parsed: unknown
	try {
		parsed = await res.json()
	} catch {
		return { kind: 'malformed', status: res.status }
	}

	if (!isHeartbeatBody(parsed)) {
		return { kind: 'malformed', status: res.status }
	}
	return { kind: 'ok', body: parsed }
}

function isHeartbeatBody(x: unknown): x is HeartbeatBody {
	if (typeof x !== 'object' || x === null) return false
	const o = x as Record<string, unknown>
	const latestOk = o.latest_completed_at === null || typeof o.latest_completed_at === 'string'
	const minutesOk =
		o.minutes_since === null ||
		(typeof o.minutes_since === 'number' && Number.isInteger(o.minutes_since))
	return latestOk && minutesOk
}
