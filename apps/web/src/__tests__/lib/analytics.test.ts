import { trackEvent } from '@/lib/analytics'
import { setApiKey, setStoredActor } from '@/lib/auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'

function setWorkspaceUrl(workspaceId: string | null) {
	const path = workspaceId ? `/${workspaceId}/objects` : '/login'
	window.history.replaceState({}, '', path)
}

beforeEach(() => {
	localStorage.clear()
	vi.spyOn(console, 'info').mockImplementation(() => {})
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 202 })))
	setWorkspaceUrl(null)
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
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

	it('POSTs the event to /api/analytics when authenticated inside a workspace', () => {
		setApiKey('ank_test_key')
		setWorkspaceUrl(WORKSPACE_ID)

		trackEvent('menu_opened', { objectType: 'bet', objectId: 'obj-1' })

		expect(fetch).toHaveBeenCalledTimes(1)
		const [url, init] = vi.mocked(fetch).mock.calls[0]
		expect(url).toBe('/api/analytics')
		const headers = init?.headers as Record<string, string>
		expect(headers['X-Workspace-Id']).toBe(WORKSPACE_ID)
		expect(headers.Authorization).toBe('Bearer ank_test_key')
		expect(headers['Content-Type']).toBe('application/json')
		const body = JSON.parse(init?.body as string) as {
			name: string
			props: Record<string, unknown>
			ts: string
		}
		expect(body.name).toBe('menu_opened')
		expect(body.props).toEqual({ objectType: 'bet', objectId: 'obj-1' })
		expect(typeof body.ts).toBe('string')
	})

	it('does not POST when there is no workspace id in the URL', () => {
		setApiKey('ank_test_key')
		setWorkspaceUrl(null)

		trackEvent('menu_opened', {})

		expect(fetch).not.toHaveBeenCalled()
	})

	it('does not POST when there is no api key', () => {
		setWorkspaceUrl(WORKSPACE_ID)

		trackEvent('menu_opened', {})

		expect(fetch).not.toHaveBeenCalled()
	})

	it('swallows a rejected fetch without breaking the UI', async () => {
		setApiKey('ank_test_key')
		setWorkspaceUrl(WORKSPACE_ID)
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

		expect(() => trackEvent('menu_opened', {})).not.toThrow()

		// Let the swallowed rejection settle without surfacing an unhandled error.
		await Promise.resolve()
	})

	it('swallows a synchronously-thrown fetch without breaking the UI', () => {
		setApiKey('ank_test_key')
		setWorkspaceUrl(WORKSPACE_ID)
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				throw new Error('fetch unavailable')
			}),
		)

		expect(() => trackEvent('menu_opened', {})).not.toThrow()
	})
})
