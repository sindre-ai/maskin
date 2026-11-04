import type { Database } from '@maskin/db'
import {
	LIFECYCLE,
	LifecyclePushScheduler,
	lifecycleEnabled,
} from '../../services/lifecycle-push-scheduler'

describe('lifecycleEnabled', () => {
	it('is off by default and only on for 1 / true', () => {
		expect(lifecycleEnabled({})).toBe(false)
		expect(lifecycleEnabled({ PUSH_LIFECYCLE_ENABLED: '' })).toBe(false)
		expect(lifecycleEnabled({ PUSH_LIFECYCLE_ENABLED: '0' })).toBe(false)
		expect(lifecycleEnabled({ PUSH_LIFECYCLE_ENABLED: 'yes' })).toBe(false)
		expect(lifecycleEnabled({ PUSH_LIFECYCLE_ENABLED: '1' })).toBe(true)
		expect(lifecycleEnabled({ PUSH_LIFECYCLE_ENABLED: ' TRUE ' })).toBe(true)
	})

	it('a disabled scheduler never touches the database', async () => {
		const db = new Proxy(
			{},
			{
				get: () => {
					throw new Error('db touched')
				},
			},
		) as unknown as Database
		const s = new LifecyclePushScheduler(db, {})
		await expect(s.tick(new Date())).resolves.toBe(0)
		s.start() // does not start a timer when disabled
		s.stop()
	})
})

describe('LIFECYCLE windows', () => {
	it('keeps the conservative bounds the rules are documented with', () => {
		expect(LIFECYCLE.newActorMaxAgeMs).toBe(14 * 24 * 3600_000)
		expect(LIFECYCLE.activationMinAgeMs).toBe(3 * 24 * 3600_000)
		expect(LIFECYCLE.activationMaxAgeMs).toBeLessThanOrEqual(LIFECYCLE.newActorMaxAgeMs)
		expect(LIFECYCLE.reminderMinAgeMs).toBe(24 * 3600_000)
		expect(LIFECYCLE.reminderMaxAgeMs).toBeGreaterThan(LIFECYCLE.reminderMinAgeMs)
	})
})
