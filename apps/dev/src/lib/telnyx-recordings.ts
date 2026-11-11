const TELNYX_API = 'https://api.telnyx.com/v2'
const REQUEST_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 60_000
/** A phone-call mp3 is well under this; a bigger body means something is wrong. */
export const MAX_RECORDING_BYTES = 100 * 1024 * 1024
const PAGE_SIZE = 250

export interface TelnyxRecording {
	id: string
	callSessionId: string | null
	from: string | null
	to: string | null
	status: string | null
	durationMillis: number | null
	startedAt: string
	mp3Url: string | null
}

/** Telnyx answered with an error. `code` is the Telnyx error code when the body carried one. */
export class TelnyxApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string | null,
		message: string,
	) {
		super(message)
		this.name = 'TelnyxApiError'
	}
}

interface RawRecording {
	id?: unknown
	call_session_id?: unknown
	from?: unknown
	to?: unknown
	status?: unknown
	duration_millis?: unknown
	recording_started_at?: unknown
	created_at?: unknown
	download_urls?: { mp3?: unknown } | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

function parseRecording(raw: RawRecording): TelnyxRecording | null {
	const id = str(raw.id)
	const startedAt = str(raw.recording_started_at) ?? str(raw.created_at)
	if (!id || !startedAt) return null
	return {
		id,
		callSessionId: str(raw.call_session_id),
		from: str(raw.from),
		to: str(raw.to),
		status: str(raw.status),
		durationMillis: typeof raw.duration_millis === 'number' ? raw.duration_millis : null,
		startedAt,
		mp3Url: str(raw.download_urls?.mp3),
	}
}

async function telnyxError(res: Response): Promise<TelnyxApiError> {
	let code: string | null = null
	let detail = ''
	try {
		const body = (await res.json()) as { errors?: { code?: unknown; detail?: unknown }[] }
		const first = body.errors?.[0]
		code = first?.code !== undefined ? String(first.code) : null
		detail = typeof first?.detail === 'string' ? first.detail : ''
	} catch {
		// Not JSON; the status is all there is.
	}
	return new TelnyxApiError(
		res.status,
		code,
		`Telnyx answered ${res.status}${code ? ` (error ${code})` : ''}${detail ? `: ${detail}` : ''}`,
	)
}

/**
 * Every recording Telnyx holds that was created at or after `since`, oldest page
 * first. Pages through the whole list; a failed page throws, so the caller never
 * mistakes a partial list for the full one.
 */
export async function listRecordings(
	apiKey: string,
	since: Date,
	fetchFn: typeof fetch = fetch,
): Promise<TelnyxRecording[]> {
	const out: TelnyxRecording[] = []
	for (let page = 1; ; page++) {
		const url = new URL(`${TELNYX_API}/recordings`)
		url.searchParams.set('filter[created_at][gte]', since.toISOString())
		url.searchParams.set('page[size]', String(PAGE_SIZE))
		url.searchParams.set('page[number]', String(page))
		const res = await fetchFn(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
		if (!res.ok) throw await telnyxError(res)
		const body = (await res.json()) as {
			data?: RawRecording[]
			meta?: { total_pages?: number }
		}
		for (const raw of body.data ?? []) {
			const rec = parseRecording(raw)
			if (rec) out.push(rec)
		}
		if (page >= (body.meta?.total_pages ?? 1)) return out
	}
}

/**
 * A fresh mp3 link for one recording. The links in the list are only good for 10
 * minutes, so the caller asks for a new one right before each download.
 */
export async function getRecordingDownloadUrl(
	apiKey: string,
	recordingId: string,
	fetchFn: typeof fetch = fetch,
): Promise<string | null> {
	const res = await fetchFn(`${TELNYX_API}/recordings/${encodeURIComponent(recordingId)}`, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	})
	if (!res.ok) throw await telnyxError(res)
	const body = (await res.json()) as { data?: RawRecording }
	return str(body.data?.download_urls?.mp3)
}

/** The mp3 bytes. The download URL is pre-signed, so no auth header goes with it. */
export async function downloadRecording(
	url: string,
	fetchFn: typeof fetch = fetch,
): Promise<Buffer> {
	const res = await fetchFn(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
	if (!res.ok) throw await telnyxError(res)
	const bytes = Buffer.from(await res.arrayBuffer())
	if (bytes.byteLength === 0) throw new Error('Telnyx returned an empty recording')
	if (bytes.byteLength > MAX_RECORDING_BYTES) {
		throw new Error(`Recording is ${bytes.byteLength} bytes, over the ${MAX_RECORDING_BYTES} cap`)
	}
	return bytes
}
