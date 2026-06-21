import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CoolifyHeartbeatWatchdog } from '../../services/coolify-heartbeat-watchdog'
import { buildIntegration } from '../factories'
import { createTestContext } from '../setup'

const wsA = '00000000-0000-0000-0000-0000000000a1'
const actorA = '00000000-0000-0000-0000-0000000000b1'

beforeAll(() => {
	process.env.COOLIFY_OBSERVABILITY_ENABLED = 'true'
})

afterAll(() => {
	process.env.COOLIFY_OBSERVABILITY_ENABLED = undefined
})

describe('CoolifyHeartbeatWatchdog', () => {
	let ctx: ReturnType<typeof createTestContext>
	beforeEach(() => {
		ctx = createTestContext()
	})

	it('AC-T7: emits a silence insight when last_event_at is older than the threshold', async () => {
		const old = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString()
		const integration = buildIntegration({
			workspaceId: wsA,
			provider: 'coolify',
			status: 'active',
			createdBy: actorA,
			config: { last_event_at: old },
		})
		ctx.mockResults.select = [integration]
		ctx.mockResults.insert = [{ id: 'silence-insight' }]

		const watchdog = new CoolifyHeartbeatWatchdog(ctx.db)
		await watchdog.tick()

		const insightInsert = ctx.calls.inserts.find((c) => {
			const obj = c as Record<string, unknown>
			return obj.type === 'insight'
		}) as Record<string, unknown> | undefined
		expect(insightInsert).toBeDefined()
		expect((insightInsert?.title as string).includes('silent')).toBe(true)
		const meta = insightInsert?.metadata as Record<string, unknown>
		expect(meta.urgent).toBe(true)
		expect(meta.source).toBe('coolify_silence')
		expect(meta.kind).toBe('silence_alert')
	})

	it('does not emit when the integration is within the silence threshold', async () => {
		const fresh = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
		const integration = buildIntegration({
			workspaceId: wsA,
			provider: 'coolify',
			status: 'active',
			createdBy: actorA,
			config: { last_event_at: fresh },
		})
		ctx.mockResults.select = [integration]

		const watchdog = new CoolifyHeartbeatWatchdog(ctx.db)
		await watchdog.tick()

		const insightInsert = ctx.calls.inserts.find((c) => {
			const obj = c as Record<string, unknown>
			return obj.type === 'insight'
		})
		expect(insightInsert).toBeUndefined()
	})

	it('does not re-alert an integration that was already alerted in the last 24h', async () => {
		const old = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString()
		const recentAlert = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
		const integration = buildIntegration({
			workspaceId: wsA,
			provider: 'coolify',
			status: 'active',
			createdBy: actorA,
			config: { last_event_at: old, last_silence_alerted_at: recentAlert },
		})
		ctx.mockResults.select = [integration]

		const watchdog = new CoolifyHeartbeatWatchdog(ctx.db)
		await watchdog.tick()

		const insightInsert = ctx.calls.inserts.find((c) => {
			const obj = c as Record<string, unknown>
			return obj.type === 'insight'
		})
		expect(insightInsert).toBeUndefined()
	})

	it('no-ops when the feature flag is off', async () => {
		const previous = process.env.COOLIFY_OBSERVABILITY_ENABLED
		process.env.COOLIFY_OBSERVABILITY_ENABLED = 'false'
		try {
			ctx.mockResults.select = []
			const watchdog = new CoolifyHeartbeatWatchdog(ctx.db)
			await watchdog.tick()
			expect(ctx.calls.inserts.length).toBe(0)
		} finally {
			process.env.COOLIFY_OBSERVABILITY_ENABLED = previous
		}
	})
})
