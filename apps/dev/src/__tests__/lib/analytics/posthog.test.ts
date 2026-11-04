import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { actors } from '@maskin/db/schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetPosthogEventBudgetForTesting } from '../../../lib/analytics/event-budget'
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
		__resetPosthogEventBudgetForTesting()
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
			surface: 'backend',
			actor_type: 'system',
			$process_person_profile: false,
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
		await capturePosthogEvent('agent_session_started', 'actor-1', props)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('sends as before when the workspace has no privacy block (defaults: share on, anonymise off)', async () => {
		configurePosthogPrivacy(fakeDb({}).db)
		await capturePosthogEvent('agent_session_started', 'actor-1', props)
		const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
		expect(body.distinct_id).toBe('actor-1')
		expect(body.properties).toEqual({
			...props,
			surface: 'backend',
			actor_type: 'system',
			$process_person_profile: false,
		})
	})

	it('hashes the distinct id and drops names and emails when anonymise is on', async () => {
		configurePosthogPrivacy(
			fakeDb({ privacy: { share_usage: true, anonymize_workspace: true } }).db,
		)
		await capturePosthogEvent('agent_session_started', 'actor-1', props)
		const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
		// SHA-256 of 'actor-1', the same treatment as the web's hashDistinctId.
		expect(body.distinct_id).toBe(createHash('sha256').update('actor-1').digest('hex'))
		expect(body.properties).toEqual({
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			tool_name: 'create_objects',
			count: 3,
			surface: 'backend',
			actor_type: 'system',
			$process_person_profile: false,
		})
	})

	it('sends nothing when the setting cannot be read (fails closed)', async () => {
		configurePosthogPrivacy(fakeDb(new Error('db down')).db)
		await expect(
			capturePosthogEvent('agent_session_started', 'actor-1', props),
		).resolves.toBeUndefined()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('sends nothing when the workspace row is missing', async () => {
		configurePosthogPrivacy(fakeDb(null).db)
		await capturePosthogEvent('agent_session_started', 'actor-1', props)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('sends nothing for a workspace event before the lookup is wired', async () => {
		__resetPosthogPrivacyForTesting()
		await capturePosthogEvent('agent_session_started', 'actor-1', props)
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

	describe('event budget', () => {
		beforeEach(() => {
			vi.stubEnv('POSTHOG_API_KEY', 'phc_test')
		})

		it('stamps sample_rate on a sampled event and sends nothing when the draw misses', async () => {
			const random = vi.spyOn(Math, 'random').mockReturnValue(0)
			await capturePosthogEvent('mcp_handshake', 'actor-1', { client: 'claude' })
			expect(fetchMock).toHaveBeenCalledOnce()
			const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
			expect(body.properties).toMatchObject({ client: 'claude', sample_rate: 0.1 })

			random.mockReturnValue(0.99)
			await capturePosthogEvent('mcp_handshake', 'actor-1', { client: 'claude' })
			expect(fetchMock).toHaveBeenCalledOnce()
			random.mockRestore()
		})

		it('stops sending an event name once it reaches its daily cap', async () => {
			vi.stubEnv('POSTHOG_EVENT_DAILY_CAP', '2')
			vi.spyOn(logger, 'warn').mockImplementation(() => {})
			for (let i = 0; i < 4; i++) await capturePosthogEvent('file_saved', 'actor-1', {})
			await capturePosthogEvent('agent_session_started', 'actor-1', {})
			expect(fetchMock).toHaveBeenCalledTimes(3)
		})
	})
})

describe('capturePosthogEvent shared properties', () => {
	let fetchMock: ReturnType<typeof vi.fn>
	const HUMAN = '11111111-1111-4111-8111-111111111111'
	const AGENT = '22222222-2222-4222-8222-222222222222'

	// A db that answers the workspace privacy read with an empty settings block
	// and the actor read from a fixed id -> type map.
	function dbWithActors(types: Record<string, string>) {
		const select = vi.fn(() => ({
			from: (table: unknown) => ({
				where: () => ({
					limit: async () => {
						if (table !== actors) return [{ settings: {} }]
						return Object.entries(types).map(([, type]) => ({ type }))
					},
				}),
			}),
		}))
		return { db: { select } as unknown as Database, select }
	}

	async function send(event: string, distinctId: string, props: Record<string, unknown> = {}) {
		await capturePosthogEvent(event, distinctId, props as never)
		const call = fetchMock.mock.calls.at(-1) as [string, RequestInit]
		return JSON.parse(call[1].body as string).properties as Record<string, unknown>
	}

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response)
		vi.stubGlobal('fetch', fetchMock)
		vi.stubEnv('POSTHOG_API_KEY', 'phc_test')
		// A draw of 0 always passes the sampler, so sampled event names are still sent.
		vi.spyOn(Math, 'random').mockReturnValue(0)
	})

	afterEach(() => {
		__resetPosthogPrivacyForTesting()
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
	})

	it('gives a human surface backend and no profile flag', async () => {
		configurePosthogPrivacy(dbWithActors({ [HUMAN]: 'human' }).db)
		const props = await send('workspace_member_joined', HUMAN, { workspace_id: 'ws-1' })
		expect(props).toMatchObject({ surface: 'backend', actor_type: 'human', workspace_id: 'ws-1' })
		expect(props).not.toHaveProperty('$process_person_profile')
	})

	it('turns the profile off for an agent', async () => {
		configurePosthogPrivacy(dbWithActors({ [AGENT]: 'agent' }).db)
		// agent_session_started is never sampled, so the send is not left to a random draw.
		const props = await send('agent_session_started', AGENT, { workspace_id: 'ws-1' })
		expect(props).toMatchObject({ actor_type: 'agent', $process_person_profile: false })
	})

	it('treats trigger_* events as the trigger, whoever the distinct id is', async () => {
		configurePosthogPrivacy(dbWithActors({ [HUMAN]: 'human' }).db)
		// trigger_match_failed is sampled at 0.2; a draw of 0 always sends it.
		const random = vi.spyOn(Math, 'random').mockReturnValue(0)
		const props = await send('trigger_match_failed', HUMAN, { workspace_id: 'ws-1' })
		random.mockRestore()
		expect(props).toMatchObject({ actor_type: 'trigger', $process_person_profile: false })
	})

	it('treats a distinct id that is not an actor as the system', async () => {
		const { db, select } = dbWithActors({})
		configurePosthogPrivacy(db)
		const props = await send('stripe_dispute_created', 'cus_123', {})
		expect(props).toMatchObject({ actor_type: 'system', $process_person_profile: false })
		expect(select).not.toHaveBeenCalled()
	})

	it('keeps an actor_type the caller already set', async () => {
		configurePosthogPrivacy(dbWithActors({ [AGENT]: 'agent' }).db)
		const props = await send('mcp_tool_call', AGENT, { actor_type: 'human' })
		expect(props).toMatchObject({ actor_type: 'human' })
		expect(props).not.toHaveProperty('$process_person_profile')
	})

	it('reads the actor type once for a burst of events from the same actor', async () => {
		const { db, select } = dbWithActors({ [AGENT]: 'agent' })
		configurePosthogPrivacy(db)
		await send('a', AGENT, {})
		await send('b', AGENT, {})
		expect(select).toHaveBeenCalledTimes(1)
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
