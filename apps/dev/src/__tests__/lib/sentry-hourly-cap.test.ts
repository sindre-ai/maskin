import type { ErrorEvent } from '@sentry/node'
import { describe, expect, it } from 'vitest'
import {
	HOURLY_CAP_WINDOW_MS,
	HOURLY_EVENT_CAP,
	LOW_SEVERITY_CAP,
	createSentryHourlyCap,
} from '../../lib/sentry-hourly-cap'

function setup() {
	let clock = 1_000_000
	const limit = createSentryHourlyCap(
		HOURLY_EVENT_CAP,
		LOW_SEVERITY_CAP,
		HOURLY_CAP_WINDOW_MS,
		() => clock,
	)
	const advance = (ms: number) => {
		clock += ms
	}
	return { limit, advance }
}

const event = (level?: ErrorEvent['level']): ErrorEvent =>
	({ type: undefined, level }) as ErrorEvent

describe('createSentryHourlyCap', () => {
	it('lets the hourly cap of errors through and drops the rest', () => {
		const { limit } = setup()
		for (let i = 0; i < HOURLY_EVENT_CAP; i++) expect(limit(event('error'))).not.toBeNull()
		expect(limit(event('error'))).toBeNull()
		expect(limit(event('fatal'))).toBeNull()
	})

	it('treats an event with no level as an error', () => {
		const { limit } = setup()
		for (let i = 0; i < HOURLY_EVENT_CAP; i++) expect(limit(event())).not.toBeNull()
		expect(limit(event())).toBeNull()
	})

	it('stops warnings at the low-severity cap so errors always have room', () => {
		const { limit } = setup()
		for (let i = 0; i < LOW_SEVERITY_CAP; i++) expect(limit(event('warning'))).not.toBeNull()
		expect(limit(event('warning'))).toBeNull()
		expect(limit(event('info'))).toBeNull()
		for (let i = 0; i < HOURLY_EVENT_CAP - LOW_SEVERITY_CAP; i++) {
			expect(limit(event('error'))).not.toBeNull()
		}
		expect(limit(event('error'))).toBeNull()
	})

	it('frees room as events age out of the rolling hour', () => {
		const { limit, advance } = setup()
		limit(event('error'))
		advance(HOURLY_CAP_WINDOW_MS / 2)
		for (let i = 0; i < HOURLY_EVENT_CAP - 1; i++) limit(event('error'))
		expect(limit(event('error'))).toBeNull()
		advance(HOURLY_CAP_WINDOW_MS / 2)
		expect(limit(event('error'))).not.toBeNull()
		expect(limit(event('error'))).toBeNull()
	})

	it('does not count dropped events against the hour', () => {
		const { limit, advance } = setup()
		for (let i = 0; i < HOURLY_EVENT_CAP; i++) limit(event('error'))
		advance(HOURLY_CAP_WINDOW_MS - 1)
		for (let i = 0; i < 50; i++) expect(limit(event('error'))).toBeNull()
		advance(1)
		expect(limit(event('error'))).not.toBeNull()
	})
})
