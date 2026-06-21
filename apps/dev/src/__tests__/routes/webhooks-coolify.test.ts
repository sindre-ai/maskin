import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { listProviders } from '../../lib/integrations/registry'
import { buildIntegration } from '../factories'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: webhooksCoolifyRoutes } = await import('../../routes/webhooks-coolify')

const SECRET = 'coolify-test-secret'

const sign = (body: string): string =>
	`sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`

const post = (payload: Record<string, unknown>, opts?: { skipSig?: boolean }) => {
	const body = JSON.stringify(payload)
	return new Request('http://localhost/api/webhooks-coolify', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(opts?.skipSig ? {} : { 'x-coolify-signature': sign(body) }),
		},
		body,
	})
}

const wsA = '00000000-0000-0000-0000-0000000000a1'
const actorA = '00000000-0000-0000-0000-0000000000b1'

beforeAll(() => {
	process.env.COOLIFY_WEBHOOK_SECRET = SECRET
	process.env.COOLIFY_OBSERVABILITY_ENABLED = 'true'
})

afterAll(() => {
	process.env.COOLIFY_WEBHOOK_SECRET = undefined
	process.env.COOLIFY_OBSERVABILITY_ENABLED = undefined
})

beforeEach(() => {
	vi.clearAllMocks()
})

describe('POST /api/webhooks-coolify', () => {
	it('AC-T1: deployment.failed creates an insight with deployment id, app id, error excerpt, and merged commits', async () => {
		const integration = buildIntegration({
			workspaceId: wsA,
			provider: 'coolify',
			status: 'active',
			createdBy: actorA,
			config: {},
		})
		const { app, mockResults, calls } = createTestApp(
			webhooksCoolifyRoutes,
			'/api/webhooks-coolify',
		)
		// 1. active integrations lookup, 2. existing-insight fingerprint lookup (none)
		mockResults.selectQueue = [[integration], []]
		// returning() from insert produces a row id
		mockResults.insert = [{ id: '00000000-0000-0000-0000-0000000000c1' }]

		const payload = {
			event: 'deployment.failed',
			deployment_id: 'dep-1',
			application_id: 'app-1',
			application_name: 'maskin-dev',
			commit_sha: 'a'.repeat(40),
			previous_commit_sha: 'b'.repeat(40),
			commits: [
				{ sha: 'a'.repeat(40), message: 'feat: change observability\n\nbody', author: 'magnus' },
				{ sha: 'c'.repeat(40), message: 'chore: bump version', author: 'sebk' },
			],
			error_excerpt: 'TypeError: cannot read property of undefined',
			failed_at: '2026-06-21T08:00:00.000Z',
		}

		const res = await app.request(post(payload))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.ok).toBe(true)
		expect(body.created).toBe(1)

		const insightInsert = calls.inserts[0] as Record<string, unknown>
		expect(insightInsert.type).toBe('insight')
		expect(insightInsert.title).toContain('Coolify deployment failed')
		expect(insightInsert.title).toContain('maskin-dev')
		expect((insightInsert.content as string).includes('dep-1')).toBe(true)
		expect((insightInsert.content as string).includes('a'.repeat(7))).toBe(true) // short sha rendered
		const meta = insightInsert.metadata as Record<string, unknown>
		expect(meta.urgent).toBe(true)
		expect(meta.source).toBe('coolify_deployment')
		const context = meta.context as Record<string, unknown>
		expect(context.deployment_id).toBe('dep-1')
		expect(context.application_id).toBe('app-1')
		expect((context.commits_in_deploy as unknown[]).length).toBe(2)
		expect((context.error_excerpt as string).startsWith('TypeError')).toBe(true)
	})

	it('AC-T2: application.crashed creates an insight with app id, restart count, and last commit', async () => {
		const integration = buildIntegration({
			workspaceId: wsA,
			provider: 'coolify',
			status: 'active',
			createdBy: actorA,
			config: {},
		})
		const { app, mockResults, calls } = createTestApp(
			webhooksCoolifyRoutes,
			'/api/webhooks-coolify',
		)
		mockResults.selectQueue = [[integration], []]
		mockResults.insert = [{ id: 'insight-id' }]

		const res = await app.request(
			post({
				event: 'application.crashed',
				application_id: 'app-2',
				application_name: 'maskin-api',
				restart_count: 7,
				last_commit_sha: 'd'.repeat(40),
				error_message: 'Out of memory',
				error_fingerprint: 'oom-app-2',
				crashed_at: '2026-06-21T08:01:00.000Z',
			}),
		)
		expect(res.status).toBe(200)

		const insightInsert = calls.inserts[0] as Record<string, unknown>
		expect((insightInsert.title as string).includes('crashed')).toBe(true)
		const context = (insightInsert.metadata as Record<string, unknown>).context as Record<
			string,
			unknown
		>
		expect(context.application_id).toBe('app-2')
		expect(context.restart_count).toBe(7)
		expect(context.last_commit_sha).toBe('d'.repeat(40))
	})

	it('AC-T3: application.health_check_failed creates an insight with failing check id and last_success_at', async () => {
		const integration = buildIntegration({
			workspaceId: wsA,
			provider: 'coolify',
			status: 'active',
			createdBy: actorA,
			config: {},
		})
		const { app, mockResults, calls } = createTestApp(
			webhooksCoolifyRoutes,
			'/api/webhooks-coolify',
		)
		mockResults.selectQueue = [[integration], []]
		mockResults.insert = [{ id: 'insight-id' }]

		const res = await app.request(
			post({
				event: 'application.health_check_failed',
				application_id: 'app-3',
				check_id: 'check-foo',
				last_success_at: '2026-06-21T07:55:00.000Z',
				failed_at: '2026-06-21T08:02:00.000Z',
			}),
		)
		expect(res.status).toBe(200)

		const insightInsert = calls.inserts[0] as Record<string, unknown>
		const context = (insightInsert.metadata as Record<string, unknown>).context as Record<
			string,
			unknown
		>
		expect(context.check_id).toBe('check-foo')
		expect(context.last_success_at).toBe('2026-06-21T07:55:00.000Z')
	})

	it('AC-T5: a second event with the same fingerprint updates the existing insight, no duplicate created', async () => {
		const integration = buildIntegration({
			workspaceId: wsA,
			provider: 'coolify',
			status: 'active',
			createdBy: actorA,
			config: {},
		})
		const existingInsight = {
			id: 'existing-insight',
			workspaceId: wsA,
			metadata: {
				urgent: true,
				source: 'coolify_crash',
				fingerprint: 'coolify_crash:app-2:oom-app-2',
				occurrence_count: 1,
			},
		}
		const { app, mockResults, calls } = createTestApp(
			webhooksCoolifyRoutes,
			'/api/webhooks-coolify',
		)
		// 1. active integrations, 2. existing-insight lookup returns the row
		mockResults.selectQueue = [[integration], [existingInsight]]

		const res = await app.request(
			post({
				event: 'application.crashed',
				application_id: 'app-2',
				restart_count: 8,
				error_fingerprint: 'oom-app-2',
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.updated).toBe(1)
		expect(body.created).toBe(0)

		// No `insert objects` happened — only an event row for the update
		const updateCalls = calls.updates
		expect(updateCalls.length).toBeGreaterThanOrEqual(1)
		// The first .set arg is the bumped metadata on the insight (heartbeat is also an update)
		const metadataUpdates = updateCalls.filter(
			(u) => (u as Record<string, unknown>).metadata !== undefined,
		)
		expect(metadataUpdates.length).toBeGreaterThanOrEqual(1)
		const bumped = metadataUpdates.find(
			(u) =>
				((u as Record<string, unknown>).metadata as Record<string, unknown> | undefined)
					?.occurrence_count === 2,
		)
		expect(bumped).toBeDefined()
	})

	it('AC-T8: coolify is registered as a selectable provider', () => {
		const names = listProviders().map((p) => p.config.name)
		expect(names).toContain('coolify')
	})

	it('returns 401 when signature is missing', async () => {
		const { app } = createTestApp(webhooksCoolifyRoutes, '/api/webhooks-coolify')
		const res = await app.request(post({ event: 'deployment.failed' }, { skipSig: true }))
		expect(res.status).toBe(401)
	})

	it('returns 401 when signature is invalid', async () => {
		const { app } = createTestApp(webhooksCoolifyRoutes, '/api/webhooks-coolify')
		const body = JSON.stringify({ event: 'deployment.failed' })
		const res = await app.request(
			new Request('http://localhost/api/webhooks-coolify', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-coolify-signature': 'sha256=wrong',
				},
				body,
			}),
		)
		expect(res.status).toBe(401)
	})

	it('skips silently when the feature flag is off', async () => {
		const previous = process.env.COOLIFY_OBSERVABILITY_ENABLED
		process.env.COOLIFY_OBSERVABILITY_ENABLED = 'false'
		try {
			const { app } = createTestApp(webhooksCoolifyRoutes, '/api/webhooks-coolify')
			const res = await app.request(post({ event: 'deployment.failed' }))
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.skipped).toBe('disabled')
		} finally {
			process.env.COOLIFY_OBSERVABILITY_ENABLED = previous
		}
	})

	it('acks unhandled event types without 4xx', async () => {
		const { app } = createTestApp(webhooksCoolifyRoutes, '/api/webhooks-coolify')
		const res = await app.request(post({ event: 'deployment.started' }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.skipped).toBe('unhandled_event')
	})
})
