import type { Database } from '@maskin/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetPosthogEventBudgetForTesting } from '../../lib/analytics/event-budget'
import {
	__resetPosthogPrivacyForTesting,
	configurePosthogPrivacy,
} from '../../lib/analytics/posthog'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

// POST /api/telemetry/client runs the real capture function (PostHog is a stubbed fetch), so the
// tests see what would leave the server, including the workspace's share-usage setting.
const { default: telemetryClientRoutes, resetClientTelemetryLimiterForTests } = await import(
	'../../routes/telemetry-client'
)

const wsId = '00000000-0000-0000-0000-000000000001'
const actorId = '00000000-0000-0000-0000-0000000000a1'
const memberRow = { actorId }

// A db whose only query is the workspace privacy read.
function privacyDb(settings: unknown): Database {
	return {
		select: () => ({
			from: () => ({ where: () => ({ limit: async () => [{ settings }] }) }),
		}),
	} as unknown as Database
}

function event(overrides: Record<string, unknown> = {}) {
	return {
		name: 'object_updated',
		properties: { object_id: 'abc-123', mutation_type: 'field', via: 'single', bulk_batch_size: 1 },
		occurred_at: new Date().toISOString(),
		...overrides,
	}
}

let fetchMock: ReturnType<typeof vi.fn>

async function post(events: unknown[], options: { actorType?: string; member?: boolean } = {}) {
	const { app, mockResults } = createTestApp(
		telemetryClientRoutes,
		'/api/telemetry',
		actorId,
		options.actorType ?? 'human',
	)
	mockResults.select = options.member === false ? [] : [memberRow]
	const res = await app.request(
		jsonRequest('POST', '/api/telemetry/client', { events }, { 'x-workspace-id': wsId }),
	)
	// The route does not wait for the capture, so let it finish.
	await new Promise((r) => setTimeout(r, 0))
	return res
}

/** The bodies PostHog received, parsed. */
function sent(): Array<{
	event: string
	distinct_id: string
	timestamp: string
	properties: Record<string, unknown>
}> {
	return fetchMock.mock.calls.map((call) => JSON.parse((call[1] as { body: string }).body))
}

describe('POST /api/telemetry/client', () => {
	beforeEach(() => {
		vi.stubEnv('POSTHOG_API_KEY', 'phc_test')
		fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response)
		vi.stubGlobal('fetch', fetchMock)
		__resetPosthogEventBudgetForTesting()
		resetClientTelemetryLimiterForTests()
		configurePosthogPrivacy(privacyDb({}))
	})

	afterEach(() => {
		__resetPosthogPrivacyForTesting()
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
	})

	it('sends an allowed batch with surface iphone, actor_type human and the action time', async () => {
		const at = new Date(Date.now() - 60_000).toISOString()
		const res = await post([
			event({ occurred_at: at }),
			event({ name: 'app_opened', properties: {} }),
		])

		expect(res.status).toBe(202)
		expect(await res.json()).toEqual({ accepted: 2 })
		const bodies = sent()
		expect(bodies).toHaveLength(2)
		expect(bodies[0]).toMatchObject({
			event: 'object_updated',
			distinct_id: actorId,
			timestamp: at,
			properties: {
				object_id: 'abc-123',
				workspace_id: wsId,
				actor_id: actorId,
				actor_type: 'human',
				surface: 'iphone',
				feature_area: 'objects',
			},
		})
		expect(bodies[1]?.properties).toMatchObject({ surface: 'iphone', workspace_id: wsId })
	})

	it('rejects an unknown event name with a 400 that names it, and sends nothing', async () => {
		const res = await post([event(), event({ name: 'secret_event', properties: {} })])

		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error.message).toContain('secret_event')
		expect(body.error.details[0].field).toBe('events[1].name')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('rejects a property that is not on the list and names the key', async () => {
		const res = await post([event({ properties: { object_id: 'abc', color: 'red' } })])

		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error.message).toContain('"color"')
		expect(body.error.details[0].field).toBe('events[0].properties.color')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it.each(['title', 'message', 'search_query', 'file_name', 'email', 'comment'])(
		'rejects the free-text-looking key %s',
		async (key) => {
			const res = await post([event({ properties: { object_id: 'abc', [key]: 'hello there' } })])

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain(`"${key}"`)
			expect(body.error.message).toContain('free text')
			expect(fetchMock).not.toHaveBeenCalled()
		},
	)

	it('rejects a sentence in an allowed property', async () => {
		const res = await post([
			event({ properties: { object_id: 'please send my notes to bob', mutation_type: 'field' } }),
		])

		expect(res.status).toBe(400)
		expect((await res.json()).error.details[0].field).toBe('events[0].properties.object_id')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('does not let the client set the fields the server owns', async () => {
		for (const key of ['surface', 'actor_type', 'workspace_id', 'actor_id']) {
			const res = await post([event({ properties: { object_id: 'abc', [key]: 'x' } })])
			expect(res.status).toBe(400)
		}
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('rejects more than 50 events and an empty batch', async () => {
		expect((await post(Array.from({ length: 51 }, () => event()))).status).toBe(400)
		expect((await post([])).status).toBe(400)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('accepts exactly 50 events', async () => {
		const res = await post(
			Array.from({ length: 50 }, () => event({ name: 'app_opened', properties: {} })),
		)

		expect(res.status).toBe(202)
		expect(await res.json()).toEqual({ accepted: 50 })
	})

	it('rejects an action time older than a week or ahead of the server', async () => {
		const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
		const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()

		for (const occurred_at of [old, future]) {
			const res = await post([event({ occurred_at })])
			expect(res.status).toBe(400)
			expect((await res.json()).error.details[0].field).toBe('events[0].occurred_at')
		}
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('sends nothing when the workspace has usage sharing off', async () => {
		configurePosthogPrivacy(privacyDb({ privacy: { share_usage: false } }))

		const res = await post([event()])

		expect(res.status).toBe(202)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('hashes the person id when the workspace is anonymised', async () => {
		configurePosthogPrivacy(privacyDb({ privacy: { anonymize_workspace: true } }))

		await post([event()])

		const [body] = sent()
		expect(body?.distinct_id).not.toBe(actorId)
		expect(body?.distinct_id).toMatch(/^[0-9a-f]{64}$/)
	})

	it('refuses a caller that is not a workspace member', async () => {
		const res = await post([event()], { member: false })

		expect(res.status).toBe(403)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses an agent key', async () => {
		const res = await post([event()], { actorType: 'agent' })

		expect(res.status).toBe(403)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('rate limits per actor with a Retry-After', async () => {
		for (let i = 0; i < 30; i++) {
			expect((await post([event({ name: 'app_opened', properties: {} })])).status).toBe(202)
		}

		const res = await post([event({ name: 'app_opened', properties: {} })])

		expect(res.status).toBe(429)
		expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
	})
})
