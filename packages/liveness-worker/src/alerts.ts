import type { SilenceVerdict } from './silence'

export type AlertConfig = {
	slackWebhookUrl: string
	ghDispatchToken: string
	ghDispatchRepo: string
	betUrl: string
}

export type PageContext = {
	detectedAt: Date
	verdict: Extract<SilenceVerdict, { silent: true }>
}

export type SlackMessage = {
	text: string
}

export type GhDispatchBody = {
	event_type: 'fleet.silence_detected'
	client_payload: {
		latest_completed_at: string | null
		minutes_since: number | null
		source: 'liveness-worker'
		detected_at: string
	}
}

export function buildSlackMessage(ctx: PageContext, betUrl: string): SlackMessage {
	const { verdict } = ctx
	const detail =
		verdict.reason === 'threshold_exceeded' && verdict.minutes_since !== null
			? `${verdict.minutes_since} min since the last completed session`
			: verdict.reason === 'null_latest'
				? 'no completed sessions on record'
				: verdict.reason === 'non_2xx'
					? `heartbeat returned HTTP ${verdict.status ?? '?'}`
					: verdict.reason === 'malformed'
						? `heartbeat returned HTTP ${verdict.status ?? '?'} with a malformed body`
						: `heartbeat unreachable (${verdict.error_message ?? 'network error'})`

	const last = verdict.latest_completed_at ?? '(never)'
	const text = `:rotating_light: Fleet silence detected — ${detail}. Last heartbeat: ${last}. Bet: ${betUrl}`
	return { text }
}

export function buildGhDispatchBody(ctx: PageContext): GhDispatchBody {
	const { verdict, detectedAt } = ctx
	return {
		event_type: 'fleet.silence_detected',
		client_payload: {
			latest_completed_at: verdict.latest_completed_at,
			minutes_since: verdict.minutes_since,
			source: 'liveness-worker',
			detected_at: detectedAt.toISOString(),
		},
	}
}

export async function postSlack(
	webhookUrl: string,
	msg: SlackMessage,
	fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
	// Single attempt only. A Slack outage during a fleet outage is worth logging
	// but not solving here — see brief's Out of scope.
	const res = await fetchImpl(webhookUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(msg),
	})
	return { ok: res.ok, status: res.status }
}

export async function postGhDispatch(
	repo: string,
	token: string,
	body: GhDispatchBody,
	fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
	const res = await fetchImpl(`https://api.github.com/repos/${repo}/dispatches`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'Content-Type': 'application/json',
			'User-Agent': 'maskin-liveness-worker',
		},
		body: JSON.stringify(body),
	})
	return { ok: res.ok, status: res.status }
}
