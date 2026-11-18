import { YoutubeError } from './errors'

/**
 * Request rules for youtube__get_analytics (YouTube Analytics API reports.query), checked before
 * any quota charge or Google call. Anything outside the allowlists or caps is refused with
 * INVALID_INPUT. Own channel only: the report always asks for channel==MINE, and the caller
 * cannot supply ids or any other filter. Numbers come back as the API gives them: nothing here
 * computes a rate, a growth figure or a score (policy item P8).
 */
export const ANALYTICS_METRICS = [
	'views',
	'estimatedMinutesWatched',
	'averageViewDuration',
	'averageViewPercentage',
	'subscribersGained',
] as const

/** elapsedVideoTimeRatio is the retention dimension and needs a single video (video_id). */
export const ANALYTICS_DIMENSIONS = [
	'video',
	'day',
	'elapsedVideoTimeRatio',
	'insightTrafficSourceType',
] as const

export const ANALYTICS_MAX_RANGE_DAYS = 90
export const ANALYTICS_MAX_ROWS = 200

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/
const DAY_MS = 24 * 60 * 60 * 1000

export interface AnalyticsInput {
	/** First day of the range, YYYY-MM-DD, inclusive. */
	start_date: string
	/** Last day of the range, YYYY-MM-DD, inclusive. */
	end_date: string
	metrics: string[]
	dimensions?: string[]
	/** Metrics or dimensions to sort by, in order. A leading minus sorts descending. */
	sort?: string[]
	/** Limit the report to one of the channel's videos. Required for elapsedVideoTimeRatio. */
	video_id?: string
	max_results?: number
}

function refuse(message: string, hint?: string): never {
	throw new YoutubeError({ code: 'INVALID_INPUT', message, hint })
}

function parseDay(value: unknown, field: string): number {
	if (typeof value !== 'string' || !DATE_RE.test(value)) {
		refuse(`${field} must be a date written YYYY-MM-DD.`)
	}
	const ms = Date.parse(`${value}T00:00:00Z`)
	// Date.parse rolls 2026-02-31 into March, so compare the round trip.
	if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
		refuse(`${field} is not a real date.`)
	}
	return ms
}

function checkList(
	values: unknown,
	allowed: readonly string[],
	field: string,
	{ required }: { required: boolean },
): string[] {
	if (values === undefined && !required) return []
	if (!Array.isArray(values) || values.length === 0) {
		refuse(`${field} must be a non-empty list.`, `Allowed: ${allowed.join(', ')}.`)
	}
	const seen = new Set<string>()
	for (const v of values) {
		if (typeof v !== 'string' || !allowed.includes(v)) {
			refuse(`${field} contains a value that is not allowed.`, `Allowed: ${allowed.join(', ')}.`)
		}
		seen.add(v)
	}
	return [...seen]
}

/**
 * Validate a tool call and build the reports.query parameters. Pure: no I/O, so a refused call
 * costs nothing. Returns only keys the Analytics API defines.
 */
export function buildAnalyticsQuery(input: AnalyticsInput): Record<string, string> {
	const start = parseDay(input.start_date, 'start_date')
	const end = parseDay(input.end_date, 'end_date')
	if (end < start) refuse('end_date is before start_date.')
	const days = Math.round((end - start) / DAY_MS) + 1
	if (days > ANALYTICS_MAX_RANGE_DAYS) {
		refuse(
			`The date range is ${days} days. The most allowed is ${ANALYTICS_MAX_RANGE_DAYS}.`,
			'Ask for a shorter range, or run several reports.',
		)
	}

	const metrics = checkList(input.metrics, ANALYTICS_METRICS, 'metrics', { required: true })
	const dimensions = checkList(input.dimensions, ANALYTICS_DIMENSIONS, 'dimensions', {
		required: false,
	})

	let maxResults = ANALYTICS_MAX_ROWS
	if (input.max_results !== undefined) {
		if (!Number.isInteger(input.max_results) || input.max_results < 1) {
			refuse('max_results must be a whole number of 1 or more.')
		}
		if (input.max_results > ANALYTICS_MAX_ROWS) {
			refuse(`max_results is above the cap of ${ANALYTICS_MAX_ROWS} rows.`)
		}
		maxResults = input.max_results
	}

	const params: Record<string, string> = {
		ids: 'channel==MINE',
		startDate: input.start_date,
		endDate: input.end_date,
		metrics: metrics.join(','),
		maxResults: String(maxResults),
	}
	if (dimensions.length > 0) params.dimensions = dimensions.join(',')

	if (input.video_id !== undefined) {
		if (typeof input.video_id !== 'string' || !VIDEO_ID_RE.test(input.video_id)) {
			refuse('video_id is not a YouTube video id.')
		}
		params.filters = `video==${input.video_id}`
	} else if (dimensions.includes('elapsedVideoTimeRatio')) {
		refuse('elapsedVideoTimeRatio needs a video_id: retention is read one video at a time.')
	}

	if (input.sort !== undefined) {
		if (!Array.isArray(input.sort) || input.sort.length === 0) {
			refuse('sort must be a non-empty list.')
		}
		const sortable = [...metrics, ...dimensions]
		for (const key of input.sort) {
			const name = typeof key === 'string' && key.startsWith('-') ? key.slice(1) : key
			if (typeof name !== 'string' || !sortable.includes(name)) {
				refuse('sort can only use a metric or dimension that is in this report.')
			}
		}
		params.sort = input.sort.join(',')
	}

	return params
}
