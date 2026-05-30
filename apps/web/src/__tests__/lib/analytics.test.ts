import { trackEvent } from '@/lib/analytics'
import { setStoredActor } from '@/lib/auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
	localStorage.clear()
	vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('trackEvent', () => {
	it('emits a console.info line tagged [analytics] with name and props', () => {
		trackEvent('objects_control_changed', { source: 'objects-page', control: 'status_filter' })

		expect(console.info).toHaveBeenCalledTimes(1)
		const [tag, payload] = vi.mocked(console.info).mock.calls[0]
		expect(tag).toBe('[analytics]')
		expect(payload).toMatchObject({
			name: 'objects_control_changed',
			source: 'objects-page',
			control: 'status_filter',
			actorId: null,
		})
		expect(typeof (payload as { ts: string }).ts).toBe('string')
	})

	it('includes the stored actor id when authenticated', () => {
		setStoredActor({ id: 'actor-42', name: 'Sebastian', type: 'human', email: null })

		trackEvent('objects_control_changed', { control: 'sort_by' })

		const [, payload] = vi.mocked(console.info).mock.calls[0]
		expect((payload as { actorId: string | null }).actorId).toBe('actor-42')
	})

	it('never throws even if the actor lookup fails', () => {
		// Force localStorage.getItem to throw, simulating a broken environment
		const original = Storage.prototype.getItem
		Storage.prototype.getItem = () => {
			throw new Error('boom')
		}

		expect(() => trackEvent('objects_control_changed', {})).not.toThrow()

		Storage.prototype.getItem = original
	})
})
