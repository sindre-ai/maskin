import { describe, expect, it } from 'vitest'
import {
	ANALYTICS_DIMENSIONS,
	ANALYTICS_MAX_RANGE_DAYS,
	ANALYTICS_MAX_ROWS,
	ANALYTICS_METRICS,
	type AnalyticsInput,
	buildAnalyticsQuery,
} from '../../../lib/integrations/providers/youtube/analytics'

const base: AnalyticsInput = {
	start_date: '2026-10-01',
	end_date: '2026-10-31',
	metrics: ['views'],
}

const refused = (input: unknown) => {
	try {
		buildAnalyticsQuery(input as AnalyticsInput)
	} catch (err) {
		return err
	}
	throw new Error('expected the query to be refused')
}

describe('buildAnalyticsQuery', () => {
	it('builds a report for the own channel only', () => {
		expect(buildAnalyticsQuery(base)).toEqual({
			ids: 'channel==MINE',
			startDate: '2026-10-01',
			endDate: '2026-10-31',
			metrics: 'views',
			maxResults: String(ANALYTICS_MAX_ROWS),
		})
	})

	it('accepts every allowlisted metric and dimension', () => {
		const out = buildAnalyticsQuery({
			...base,
			metrics: [...ANALYTICS_METRICS],
			dimensions: ['video', 'day', 'insightTrafficSourceType'],
		})
		expect(out.metrics).toBe(ANALYTICS_METRICS.join(','))
		expect(out.dimensions).toBe('video,day,insightTrafficSourceType')
		expect(ANALYTICS_DIMENSIONS).toContain('elapsedVideoTimeRatio')
	})

	it('refuses a metric that is not on the allowlist, incl. revenue', () => {
		for (const metric of ['estimatedRevenue', 'likes', 'audienceWatchRatio', 'views,likes']) {
			expect(refused({ ...base, metrics: ['views', metric] })).toMatchObject({
				code: 'INVALID_INPUT',
			})
		}
	})

	it('refuses a dimension that is not on the allowlist', () => {
		for (const dimension of ['country', 'ageGroup', 'channel', 'month']) {
			expect(refused({ ...base, dimensions: [dimension] })).toMatchObject({
				code: 'INVALID_INPUT',
			})
		}
	})

	it('refuses an empty or missing metrics list', () => {
		expect(refused({ ...base, metrics: [] })).toMatchObject({ code: 'INVALID_INPUT' })
		expect(refused({ ...base, metrics: undefined })).toMatchObject({ code: 'INVALID_INPUT' })
		expect(refused({ ...base, metrics: 'views' })).toMatchObject({ code: 'INVALID_INPUT' })
	})

	it('allows exactly 90 days and refuses 91', () => {
		expect(ANALYTICS_MAX_RANGE_DAYS).toBe(90)
		// 1 Oct to 29 Dec inclusive is 90 days.
		expect(buildAnalyticsQuery({ ...base, end_date: '2026-12-29' }).endDate).toBe('2026-12-29')
		expect(refused({ ...base, end_date: '2026-12-30' })).toMatchObject({
			code: 'INVALID_INPUT',
			message: expect.stringContaining('91 days'),
		})
	})

	it('refuses an end before the start and dates that are not real', () => {
		expect(refused({ ...base, end_date: '2026-09-30' })).toMatchObject({ code: 'INVALID_INPUT' })
		for (const date of ['2026-02-31', '2026-13-01', '10/01/2026', '2026-10-1', 'today', 20261001]) {
			expect(refused({ ...base, start_date: date })).toMatchObject({ code: 'INVALID_INPUT' })
			expect(refused({ ...base, end_date: date })).toMatchObject({ code: 'INVALID_INPUT' })
		}
	})

	it('caps rows at 200 and defaults to the cap', () => {
		expect(buildAnalyticsQuery({ ...base, max_results: 200 }).maxResults).toBe('200')
		expect(buildAnalyticsQuery({ ...base, max_results: 10 }).maxResults).toBe('10')
		for (const n of [201, 0, -1, 1.5, Number.NaN]) {
			expect(refused({ ...base, max_results: n })).toMatchObject({ code: 'INVALID_INPUT' })
		}
	})

	it('retention needs one video, and the video filter is fixed in shape', () => {
		expect(refused({ ...base, dimensions: ['elapsedVideoTimeRatio'] })).toMatchObject({
			code: 'INVALID_INPUT',
		})
		const out = buildAnalyticsQuery({
			...base,
			dimensions: ['elapsedVideoTimeRatio'],
			video_id: 'dQw4w9WgXcQ',
		})
		expect(out.filters).toBe('video==dQw4w9WgXcQ')
		// No way to smuggle another filter or another channel through the video id.
		for (const id of ['x;channel==UC123', 'short', 'dQw4w9WgXcQ,video==abc', '']) {
			expect(refused({ ...base, video_id: id })).toMatchObject({ code: 'INVALID_INPUT' })
		}
	})

	it('sorts only by something in the report', () => {
		const out = buildAnalyticsQuery({
			...base,
			metrics: ['views'],
			dimensions: ['video'],
			sort: ['-views', 'video'],
		})
		expect(out.sort).toBe('-views,video')
		expect(refused({ ...base, sort: ['-estimatedMinutesWatched'] })).toMatchObject({
			code: 'INVALID_INPUT',
		})
		expect(refused({ ...base, sort: [] })).toMatchObject({ code: 'INVALID_INPUT' })
	})

	it('ignores ids, filters and other keys the caller adds', () => {
		const out = buildAnalyticsQuery({
			...base,
			ids: 'channel==UCsomeoneelse',
			filters: 'channel==UCsomeoneelse',
			currency: 'USD',
		} as AnalyticsInput)
		expect(out.ids).toBe('channel==MINE')
		expect(out.filters).toBeUndefined()
		expect(Object.keys(out).sort()).toEqual(
			['endDate', 'ids', 'maxResults', 'metrics', 'startDate'].sort(),
		)
	})

	it('error text carries no input echo beyond the allowed names', () => {
		const err = refused({ ...base, metrics: ['secret-looking-value'] }) as Error
		expect(err.message).not.toContain('secret-looking-value')
	})
})
