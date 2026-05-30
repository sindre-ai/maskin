import { trackEvent } from '@/lib/analytics'
import { setApiKey, setStoredActor } from '@/lib/auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wsId = '00000000-0000-0000-0000-000000000001'

function setPath(pathname: string) {
	window.history.replaceState({}, '', pathname)
}

beforeEach(() => {
	localStorage.clear()
	vi.spyOn(console, 'info').mockImplementation(() => {})
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 202 })))
	setPath('/')
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	setPath('/')
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

	describe('server-side sink', () => {
		it('POSTs to /api/analytics with workspace and auth headers when authed under a workspace URL', () => {
			setApiKey('ank_test')
			setStoredActor({ id: 'actor-42', name: 'Sebastian', type: 'human', email: null })
			setPath(`/${wsId}/objects`)

			trackEvent('menu_opened', { objectType: 'bet', objectId: 'abc-123' })

			expect(fetch).toHaveBeenCalledTimes(1)
			const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
			expect(url).toBe('/api/analytics')
			expect(init.method).toBe('POST')
			const headers = init.headers as Record<string, string>
			expect(headers.Authorization).toBe('Bearer ank_test')
			expect(headers['X-Workspace-Id']).toBe(wsId)
			const body = JSON.parse(init.body as string)
			expect(body).toMatchObject({
				name: 'menu_opened',
				props: { objectType: 'bet', objectId: 'abc-123' },
			})
			expect(typeof body.ts).toBe('string')
		})

		it('strips undefined props before sending', () => {
			setApiKey('ank_test')
			setPath(`/${wsId}/objects`)

			trackEvent('menu_opened', { objectType: 'bet', objectId: undefined })

			const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit
			const body = JSON.parse(init.body as string)
			expect(body.props).toEqual({ objectType: 'bet' })
		})

		it('skips the POST when no workspace id is in the URL', () => {
			setApiKey('ank_test')
			setPath('/login')

			trackEvent('menu_opened', {})

			expect(fetch).not.toHaveBeenCalled()
		})

		it('skips the POST when there is no api key', () => {
			setPath(`/${wsId}/objects`)

			trackEvent('menu_opened', {})

			expect(fetch).not.toHaveBeenCalled()
		})

		it('swallows a thrown fetch so trackEvent never raises', () => {
			setApiKey('ank_test')
			setPath(`/${wsId}/objects`)
			vi.stubGlobal(
				'fetch',
				vi.fn(() => {
					throw new Error('network down')
				}),
			)

			expect(() => trackEvent('menu_opened', {})).not.toThrow()
		})

		it('swallows a rejected fetch promise', async () => {
			setApiKey('ank_test')
			setPath(`/${wsId}/objects`)
			vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

			expect(() => trackEvent('menu_opened', {})).not.toThrow()
			// Let the rejected promise settle so its handler runs without unhandled rejection.
			await Promise.resolve()
		})
	})
})
