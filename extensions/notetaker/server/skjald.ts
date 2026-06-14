/**
 * Skjald `/api/bots` client — single POST per dispatch, no retry. The poller
 * runs every minute and naturally re-tries by leaving the meeting in
 * `status=scheduled` with no `skjaldBotId` saved.
 *
 * Spec §5.1: `Authorization: Bearer {SKJALD_API_KEY}`, body carries
 * `metadata={maskinMeetingId, maskinWorkspaceId}`, 201 returns `{ id, status }`.
 */

export interface DispatchRequest {
	meetingUrl: string
	botName?: string
	maskinMeetingId: string
	maskinWorkspaceId: string
}

export interface DispatchResponse {
	skjaldBotId: string
	status: string
}

export class SkjaldDispatchError extends Error {
	constructor(
		message: string,
		public readonly httpStatus: number,
		public readonly responseBody: string,
	) {
		super(message)
		this.name = 'SkjaldDispatchError'
	}
}

type FetchLike = typeof fetch

export interface SkjaldClientOptions {
	skjaldUrl: string
	apiKey: string
	fetchImpl?: FetchLike
}

export async function dispatchToSkjald(
	opts: SkjaldClientOptions,
	req: DispatchRequest,
): Promise<DispatchResponse> {
	const fetchImpl = opts.fetchImpl ?? fetch
	const base = opts.skjaldUrl.replace(/\/+$/, '')
	const url = `${base}/api/bots`
	const body = {
		meetingUrl: req.meetingUrl,
		botName: req.botName ?? 'Notetaker',
		metadata: {
			maskinMeetingId: req.maskinMeetingId,
			maskinWorkspaceId: req.maskinWorkspaceId,
		},
	}
	const res = await fetchImpl(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${opts.apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	})
	const text = await res.text()
	if (!res.ok) {
		throw new SkjaldDispatchError(`Skjald dispatch failed: HTTP ${res.status}`, res.status, text)
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		throw new SkjaldDispatchError('Skjald dispatch: response was not JSON', res.status, text)
	}
	const obj = parsed as { id?: unknown; status?: unknown }
	if (typeof obj.id !== 'string' || obj.id.length === 0) {
		throw new SkjaldDispatchError('Skjald dispatch: response missing string `id`', res.status, text)
	}
	return {
		skjaldBotId: obj.id,
		status: typeof obj.status === 'string' ? obj.status : 'joining',
	}
}
