import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	__resetPosthogPrivacyForTesting,
	capturePosthogEvent,
	configurePosthogPrivacy,
	warnIfPosthogKeyUnset,
} from '../../../lib/analytics/posthog'
import { logger } from '../../../lib/logger'

// A db whose only query is the workspace privacy read; `settings` is what the row holds,
// or null for no row. `select` is exposed so a test can count reads.
function fakeDb(settings: unknown | null | Error) {
	const select = vi.fn(() => ({
		from: () => ({
			where: () => ({
				limit: async () => {
					if (settings instanceof Error) throw settings
					return settings === null ? [] : [{ settings }]
				},
			}),
		}),
	}))
	return { db: { select } as unknown as Database, select }
}

describe('capturePosthogEvent', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response)
		vi.stubGlobal('fetch', fetchMock)
		configurePosthogPrivacy(fakeDb({}).db)
	})

	afterEach(() => {
		__resetPosthogPrivacyForTesting()
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

	// PostHog drops events with an empty distinct id but still answers 2xx, so
	// firing one looks successful, logs nothing, and produces no row. `POST /mcp`
	// can reach this: both `workspaceId` and `apiKey` default to '' when a caller
	// sends neither header.
	it.each([
		['empty', ''],
		['whitespace', '   '],
	])('does not post an event with a %s distinct id', async (_label, distinctId) => {
		vi.stubEnv('POSTHOG_API_KEY', 'phc_test')
		await capturePosthogEvent('mcp_tool_call', distinctId, { foo: 'bar' })
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe('capturePosthogEvent workspace privacy', () => {
	let fetchMock: ReturnType<typeof vi.fn>
	const props = {
		workspace_id: 'ws-1',
		actor_id: 'actor-1',
		email: 'a@example.com',
		name: 'Ada',
		workspace_name: 'Acme',
		agent_name: 'Coach',
		owner_email: 'o@example.com',
		tool_name: 'create_objects',
		count: 3,
	}

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response)
		vi.stubGlobal('fetch', fetchMock)
		vi.stubEnv('POSTHOG_API_KEY', 'phc_test')
		vi.spyOn(logger, 'warn').mockImplementation(() => {})
	})

	afterEach(() => {
		__resetPosthogPrivacyForTesting()
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
	})

	it('sends nothing when the workspace has share-usage off', async () => {
		configurePosthogPrivacy(fakeDb({ privacy: { share_usage: false } }).db)
		await capturePosthogEvent('agent_session_completed', 'actor-1', props)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('sends as before when the workspace has no privacy block (defaults: share on, anonymise off)', async () => {
		configurePosthogPrivacy(fakeDb({}).db)
		await capturePosthogEvent('agent_session_completed', 'actor-1', props)
		const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
		expect(body.distinct_id).toBe('actor-1')
		expect(body.properties).toEqual(props)
	})

	it('hashes the distinct id and drops names and emails when anonymise is on', async () => {
		configurePosthogPrivacy(fakeDb({ privacy: { share_usage: true, anonymize_workspace: true } }).db)
		await capturePosthogEvent('agent_session_completed', 'actor-1', props)
		const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
		// SHA-256 of 'actor-1', the same treatment as the web's hashDistinctId.
		expect(body.distinct_id).toBe(createHash('sha256').update('actor-1').digest('hex'))
		expect(body.properties).toEqual({
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			tool_name: 'create_objects',
			count: 3,
		})
	})

	it('sends nothing when the setting cannot be read (fails closed)', async () => {
		configurePosthogPrivacy(fakeDb(new Error('db down')).db)
		await expect(
			capturePosthogEvent('agent_session_completed', 'actor-1', props),
		).resolves.toBeUndefined()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('sends nothing when the workspace row is missing', async () => {
		configurePosthogPrivacy(fakeDb(null).db)
		await capturePosthogEvent('agent_session_completed', 'actor-1', props)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('sends nothing for a workspace event before the lookup is wired', async () => {
		__resetPosthogPrivacyForTesting()
		await capturePosthogEvent('agent_session_completed', 'actor-1', props)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('reads the setting once for a burst of events, and retries after a failed read', async () => {
		const ok = fakeDb({})
		configurePosthogPrivacy(ok.db)
		await Promise.all([
			capturePosthogEvent('a', 'actor-1', props),
			capturePosthogEvent('b', 'actor-1', props),
			capturePosthogEvent('c', 'actor-1', props),
		])
		expect(ok.select).toHaveBeenCalledTimes(1)
		expect(fetchMock).toHaveBeenCalledTimes(3)

		const failing = fakeDb(new Error('db down'))
		configurePosthogPrivacy(failing.db)
		await capturePosthogEvent('a', 'actor-1', props)
		await capturePosthogEvent('b', 'actor-1', props)
		expect(failing.select).toHaveBeenCalledTimes(2)
	})

	it('does not look anything up for an event with no workspace_id', async () => {
		const { db, select } = fakeDb({ privacy: { share_usage: false } })
		configurePosthogPrivacy(db)
		await capturePosthogEvent('stripe_tax_id_verified', 'cus_1', { session_id: 's1' })
		expect(select).not.toHaveBeenCalled()
		expect(fetchMock).toHaveBeenCalledOnce()
	})
})

describe('warnIfPosthogKeyUnset', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
	})

	it('warns once when production has no key', () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
		vi.stubEnv('NODE_ENV', 'production')
		vi.stubEnv('POSTHOG_API_KEY', '')
		warnIfPosthogKeyUnset()
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0][0]).toContain('POSTHOG_API_KEY')
	})

	it('treats a whitespace-only key as unset', () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
		vi.stubEnv('NODE_ENV', 'production')
		vi.stubEnv('POSTHOG_API_KEY', '   ')
		warnIfPosthogKeyUnset()
		expect(warn).toHaveBeenCalledTimes(1)
	})

	it('stays quiet when the key is set', () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
		vi.stubEnv('NODE_ENV', 'production')
		vi.stubEnv('POSTHOG_API_KEY', 'phc_test')
		warnIfPosthogKeyUnset()
		expect(warn).not.toHaveBeenCalled()
	})

	it('stays quiet outside production, where the key is routinely unset', () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
		vi.stubEnv('NODE_ENV', 'development')
		vi.stubEnv('POSTHOG_API_KEY', '')
		warnIfPosthogKeyUnset()
		expect(warn).not.toHaveBeenCalled()
	})
})
