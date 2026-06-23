import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildIntegration } from '../factories'
import { createTestApp } from '../setup'

const { default: webhooksPosthogRoutes } = await import('../../routes/webhooks-posthog')

const SECRET = 'posthog-test-secret'

const sign = (body: string): string =>
	`sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`

const post = (payload: Record<string, unknown>, opts?: { skipSig?: boolean }) => {
	const body = JSON.stringify(payload)
	return new Request('http://localhost/api/webhooks/posthog', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(opts?.skipSig ? {} : { 'x-posthog-signature': sign(body) }),
		},
		body,
	})
}

const wsA = '00000000-0000-0000-0000-0000000000a1'
const actorA = '00000000-0000-0000-0000-0000000000b1'

const exceptionPayload = (overrides?: Record<string, unknown>) => ({
	team_id: 42,
	site_url: 'https://app.maskin.io',
	event: {
		uuid: 'evt-1',
		event: '$exception',
		distinct_id: 'user-1',
		timestamp: '2026-06-21T08:00:00.000Z',
		properties: {
			$exception_fingerprint: 'fp-typeerror-1',
			$exception_type: 'TypeError',
			$exception_message: "Cannot read property 'foo' of undefined",
			$exception_list: [
				{
					type: 'TypeError',
					value: "Cannot read property 'foo' of undefined",
					stacktrace: {
						frames: [
							{ function: 'handleClick', filename: 'app.tsx', lineno: 42, colno: 11 },
							{ function: 'invoke', filename: 'react.js', lineno: 100, colno: 5 },
						],
					},
				},
			],
			$session_id: 'sess-9',
			$current_url: 'https://app.maskin.io/objects/abc',
			$browser: 'Chrome',
			$os: 'macOS',
			email: 'sebk@maskin.io',
			...((overrides?.properties as Record<string, unknown>) ?? {}),
		},
		...overrides,
	},
})

beforeAll(() => {
	process.env.POSTHOG_WEBHOOK_SECRET = SECRET
	process.env.POSTHOG_OBSERVABILITY_ENABLED = 'true'
})

afterAll(() => {
	process.env.POSTHOG_WEBHOOK_SECRET = undefined
	process.env.POSTHOG_OBSERVABILITY_ENABLED = undefined
})

beforeEach(() => {
	vi.clearAllMocks()
})

describe('POST /api/webhooks/posthog', () => {
	it('AC-T4: $exception with new fingerprint creates an insight carrying fingerprint, stack, user/session, merge-blame window', async () => {
		const integration = buildIntegration({
			workspaceId: wsA,
			provider: 'posthog',
			status: 'active',
			createdBy: actorA,
			config: {},
		})
		const { app, mockResults, calls } = createTestApp(
			webhooksPosthogRoutes,
			'/api/webhooks/posthog',
		)
		// 1. active integrations, 2. is_new_fingerprint pre-loop check (none),
		// 3. per-workspace existing-insight fingerprint lookup (none)
		mockResults.selectQueue = [[integration], [], []]
		mockResults.insert = [{ id: '00000000-0000-0000-0000-0000000000c1' }]

		const res = await app.request(post(exceptionPayload()))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.ok).toBe(true)
		expect(body.created).toBe(1)

		const insightInsert = calls.inserts[0] as Record<string, unknown>
		expect(insightInsert.type).toBe('insight')
		expect((insightInsert.title as string).includes('TypeError')).toBe(true)
		const content = insightInsert.content as string
		expect(content.includes('handleClick')).toBe(true)
		expect(content.includes('app.tsx')).toBe(true)
		expect(content.includes('sebk@maskin.io')).toBe(true)
		expect(content.includes('sess-9')).toBe(true)
		expect(content.includes('Open merged PRs on GitHub')).toBe(true)

		const meta = insightInsert.metadata as Record<string, unknown>
		expect(meta.urgent).toBe(true)
		expect(meta.source).toBe('posthog_exception')
		expect(meta.fingerprint).toBe('posthog_exception:fp-typeerror-1')
		expect(meta.occurrence_count).toBe(1)
		const context = meta.context as Record<string, unknown>
		expect(context.exception_type).toBe('TypeError')
		expect(context.session_id).toBe('sess-9')
		expect(context.user_email).toBe('sebk@maskin.io')
		expect(context.distinct_id).toBe('user-1')
		const blame = context.merge_blame_window as Record<string, string>
		expect(typeof blame.since).toBe('string')
		expect(typeof blame.until).toBe('string')
		expect(blame.pulls_url.startsWith('https://github.com/sindre-ai/maskin/pulls')).toBe(true)
	})

	it('AC-T5: a second $exception with the same fingerprint bumps occurrence_count, no duplicate insight', async () => {
		const integration = buildIntegration({
			workspaceId: wsA,
			provider: 'posthog',
			status: 'active',
			createdBy: actorA,
			config: {},
		})
		const existingInsight = {
			id: 'existing-insight',
			workspaceId: wsA,
			metadata: {
				urgent: true,
				source: 'posthog_exception',
				fingerprint: 'posthog_exception:fp-typeerror-1',
				occurrence_count: 1,
			},
		}
		const { app, mockResults, calls } = createTestApp(
			webhooksPosthogRoutes,
			'/api/webhooks/posthog',
		)
		// 1. active integrations, 2. is_new_fingerprint pre-loop (prior insight exists),
		// 3. per-workspace existing-insight lookup
		mockResults.selectQueue = [[integration], [existingInsight], [existingInsight]]

		const res = await app.request(post(exceptionPayload()))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.updated).toBe(1)
		expect(body.created).toBe(0)

		// No insight insert — only the occurrence-bump event insert
		const objectInserts = calls.inserts.filter(
			(row) => (row as Record<string, unknown>).type === 'insight',
		)
		expect(objectInserts.length).toBe(0)

		const metadataUpdates = calls.updates.filter(
			(u) => (u as Record<string, unknown>).metadata !== undefined,
		)
		const bumped = metadataUpdates.find(
			(u) =>
				((u as Record<string, unknown>).metadata as Record<string, unknown> | undefined)
					?.occurrence_count === 2,
		)
		expect(bumped).toBeDefined()
		const bumpedMeta = (bumped as Record<string, unknown>).metadata as Record<string, unknown>
		expect(bumpedMeta.last_seen_at).toBeDefined()
		expect(bumpedMeta.last_context).toBeDefined()
	})

	it('returns 401 when signature is missing', async () => {
		const { app } = createTestApp(webhooksPosthogRoutes, '/api/webhooks/posthog')
		const res = await app.request(post(exceptionPayload(), { skipSig: true }))
		expect(res.status).toBe(401)
	})

	it('returns 401 when signature is invalid', async () => {
		const { app } = createTestApp(webhooksPosthogRoutes, '/api/webhooks/posthog')
		const body = JSON.stringify(exceptionPayload())
		const res = await app.request(
			new Request('http://localhost/api/webhooks/posthog', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-posthog-signature': 'sha256=wrong',
				},
				body,
			}),
		)
		expect(res.status).toBe(401)
	})

	it('skips silently when the feature flag is off', async () => {
		const previous = process.env.POSTHOG_OBSERVABILITY_ENABLED
		process.env.POSTHOG_OBSERVABILITY_ENABLED = 'false'
		try {
			const { app } = createTestApp(webhooksPosthogRoutes, '/api/webhooks/posthog')
			const res = await app.request(post(exceptionPayload()))
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.skipped).toBe('disabled')
		} finally {
			process.env.POSTHOG_OBSERVABILITY_ENABLED = previous
		}
	})

	it('acks non-$exception event types without 4xx', async () => {
		const { app } = createTestApp(webhooksPosthogRoutes, '/api/webhooks/posthog')
		const res = await app.request(
			post({
				event: { uuid: 'evt-2', event: '$pageview', properties: {} },
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.skipped).toBe('unhandled_event')
	})

	it('emits observability_signal_received with is_new_fingerprint=true and observability_insight_created on a fresh $exception', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response)
		vi.stubGlobal('fetch', fetchMock)
		vi.stubEnv('POSTHOG_API_KEY', 'phc_test')
		vi.stubEnv('POSTHOG_HOST', '')

		try {
			const integration = buildIntegration({
				workspaceId: wsA,
				provider: 'posthog',
				status: 'active',
				createdBy: actorA,
				config: {},
			})
			const { app, mockResults } = createTestApp(webhooksPosthogRoutes, '/api/webhooks/posthog')
			mockResults.selectQueue = [[integration], [], []]
			mockResults.insert = [{ id: 'fresh-insight-id' }]

			const res = await app.request(post(exceptionPayload()))
			expect(res.status).toBe(200)

			await new Promise((r) => setTimeout(r, 0))

			const posthogCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/i/v0/e/'))
			expect(posthogCalls.length).toBe(2)
			const bodies = posthogCalls.map(([, init]) =>
				JSON.parse((init as RequestInit).body as string),
			)
			const signalEvent = bodies.find((b) => b.event === 'observability_signal_received')
			const insightEvent = bodies.find((b) => b.event === 'observability_insight_created')
			expect(signalEvent).toBeDefined()
			expect(insightEvent).toBeDefined()
			expect(signalEvent.properties.source).toBe('posthog_exception')
			expect(signalEvent.properties.is_new_fingerprint).toBe(true)
			expect(signalEvent.properties.fingerprint).toBe('posthog_exception:fp-typeerror-1')
			expect(insightEvent.properties.source).toBe('posthog_exception')
			expect(insightEvent.properties.signal_id).toBe(signalEvent.properties.signal_id)
			expect(insightEvent.properties.insight_id).toBe('fresh-insight-id')
		} finally {
			vi.unstubAllGlobals()
			vi.unstubAllEnvs()
		}
	})
})
