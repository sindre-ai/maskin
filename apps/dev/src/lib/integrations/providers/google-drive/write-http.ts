import { DriveWriteError, classifyDriveApiError } from './write-errors'

/**
 * Minimal authenticated-request plumbing for the Drive write path.
 *
 * The access token is fetched per request (not once per call) so a long
 * resumable upload keeps working past the one-hour token lifetime.
 */
export interface DriveHttp {
	fetchImpl: typeof fetch
	getAccessToken: () => Promise<string>
	sleep: (ms: number) => Promise<void>
}

export const DRIVE_API = 'https://www.googleapis.com/drive/v3'
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
export const DOCS_API = 'https://docs.googleapis.com/v1'
export const SHEETS_API = 'https://sheets.googleapis.com/v4'

export function createDriveHttp(
	overrides: Partial<DriveHttp> & Pick<DriveHttp, 'getAccessToken'>,
): DriveHttp {
	return {
		fetchImpl: overrides.fetchImpl ?? fetch,
		getAccessToken: overrides.getAccessToken,
		sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
	}
}

/**
 * JSON request against Google. Non-2xx becomes a classified DriveWriteError.
 * No automatic retry: the calls routed through here create files and comments,
 * so a blind retry could duplicate them.
 */
export async function googleJson<T>(
	http: DriveHttp,
	url: string,
	init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
	const token = await http.getAccessToken()
	let res: Response
	try {
		res = await http.fetchImpl(url, {
			method: init.method ?? 'GET',
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: 'application/json',
				...(init.body !== undefined && { 'Content-Type': 'application/json; charset=UTF-8' }),
			},
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		})
	} catch (err) {
		throw new DriveWriteError({
			code: 'PROVIDER_ERROR',
			message: 'Network failure calling Google.',
			providerStatus: 0,
		})
	}
	if (!res.ok) {
		throw classifyDriveApiError(res.status, await res.text().catch(() => ''), res.headers)
	}
	const text = await res.text()
	if (!text) return {} as T
	try {
		return JSON.parse(text) as T
	} catch {
		throw new DriveWriteError({
			code: 'PROVIDER_ERROR',
			message: 'Google returned a 2xx response with an unparseable body.',
			providerStatus: res.status,
		})
	}
}
