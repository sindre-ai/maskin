import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { capturePosthogEvent } from '../../../lib/analytics/posthog'

describe('capturePosthogEvent', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response)
		vi.stubGlobal('fetch', fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
	})

	it('does nothing when POSTHOG_API_KEY is unset', async () => {
		vi.stubEnv('POSTHOG_API_KEY', '')
		await capturePosthogEvent('test.event', 'ws-1', { foo: 'bar' })
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('posts to the default eu.i.posthog.com host with the api_key and event shape', async () => {
		vi.stubEnv('POSTHOG_API_KEY', 'phc_test')
		vi.stubEnv('POSTHOG_HOST', '')
		await capturePosthogEvent('slack.message.posted', 'ws-1', {
			workspace_id: 'ws-1',
			slack_team_id: 'T123',
			posted_as_machine: true,
			has_agent_subscript: true,
			agent_actor_id: 'actor-1',
		})

		expect(fetchMock).toHaveBeenCalledOnce()
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://eu.i.posthog.com/i/v0/e/')
		expect(init.method).toBe('POST')
		const body = JSON.parse(init.body as string)
		expect(body.api_key).toBe('phc_test')
		expect(body.event).toBe('slack.message.posted')
		expect(body.distinct_id).toBe('ws-1')
		expect(body.properties).toEqual({
			workspace_id: 'ws-1',
			slack_team_id: 'T123',
			posted_as_machine: true,
			has_agent_subscript: true,
			agent_actor_id: 'actor-1',
		})
		expect(typeof body.timestamp).toBe('string')
	})

	it('respects POSTHOG_HOST override and strips a trailing slash', async () => {
		vi.stubEnv('POSTHOG_API_KEY', 'phc_test')
		vi.stubEnv('POSTHOG_HOST', 'https://custom.posthog.test/')
		await capturePosthogEvent('test.event', 'distinct-1', {})
		const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://custom.posthog.test/i/v0/e/')
	})

	it('swallows fetch errors so the caller is never affected', async () => {
		vi.stubEnv('POSTHOG_API_KEY', 'phc_test')
		fetchMock.mockRejectedValueOnce(new Error('network down'))
		await expect(capturePosthogEvent('test.event', 'distinct-1', {})).resolves.toBeUndefined()
	})

	it('swallows non-2xx responses so the caller is never affected', async () => {
		vi.stubEnv('POSTHOG_API_KEY', 'phc_test')
		fetchMock.mockResolvedValueOnce({ ok: false, status: 500 } as Response)
		await expect(capturePosthogEvent('test.event', 'distinct-1', {})).resolves.toBeUndefined()
	})
})
