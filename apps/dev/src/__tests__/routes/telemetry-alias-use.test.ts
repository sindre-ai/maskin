import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

// The alias_use branch of `POST /api/telemetry/mcp`. Postgres is the source of
// truth for the removal check, so the row and its actor are what matter here.
const capturePosthogEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent }))

const { default: telemetryRoutes } = await import('../../routes/telemetry')

const wsId = '00000000-0000-0000-0000-000000000001'
const memberRow = { actorId: 'test-actor-id' }

function aliasBody(overrides: Record<string, unknown> = {}) {
	return {
		event_type: 'alias_use',
		tool_name: 'update_actor',
		session_id: 'mcp-alias-1',
		session_source: 'maskin-session',
		transport: 'http',
		renames: [{ old: 'driver_id', new: 'driver' }],
		both_sent: false,
		...overrides,
	}
}

async function post(
	body: Record<string, unknown>,
	opts: { member?: boolean; actorId?: string } = {},
) {
	const { app, mockResults, calls } = createTestApp(
		telemetryRoutes,
		'/api/telemetry',
		opts.actorId ?? 'test-actor-id',
		'agent',
	)
	mockResults.select = opts.member === false ? [] : [memberRow]
	mockResults.insert = [{}]
	const res = await app.request(
		jsonRequest('POST', '/api/telemetry/mcp', body, { 'x-workspace-id': wsId }),
	)
	return { res, inserts: calls.inserts as Array<Record<string, unknown>> }
}

describe('POST /api/telemetry/mcp — alias_use', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		capturePosthogEvent.mockResolvedValue(undefined)
	})

	it('persists one alias_use row carrying the renames, both_sent and transport', async () => {
		const { res, inserts } = await post(
			aliasBody({ both_sent: true, renames: [{ old: 'edges.source_id', new: 'edges.source' }] }),
		)

		expect(res.status).toBe(202)
		expect(await res.json()).toEqual({ recorded: true })
		expect(inserts).toHaveLength(1)
		expect(inserts[0]).toMatchObject({
			workspaceId: wsId,
			eventType: 'alias_use',
			toolName: 'update_actor',
			sessionId: 'mcp-alias-1',
			data: {
				renames: [{ old: 'edges.source_id', new: 'edges.source' }],
				both_sent: true,
				transport: 'http',
				tool_alias: null,
				dropped_keys: [],
			},
		})
	})

	it('takes data.agent_actor_id from the authenticated actor, not the payload', async () => {
		const { inserts } = await post(aliasBody({ agent_actor_id: 'spoofed-actor' }), {
			actorId: 'key-owner-actor',
		})

		expect(inserts).toHaveLength(1)
		const data = inserts[0]?.data as Record<string, unknown>
		expect(data.agent_actor_id).toBe('key-owner-actor')
		expect(JSON.stringify(inserts[0])).not.toContain('spoofed-actor')
	})

	it('records the tool-name alias and the dropped key names for run_agent', async () => {
		const { inserts } = await post(
			aliasBody({
				tool_name: 'run_agent',
				renames: [],
				tool_alias: { old: 'run_agent', new: 'create_session' },
				dropped_keys: ['config', 'timeout_seconds'],
			}),
		)

		expect(inserts[0]).toMatchObject({
			toolName: 'run_agent',
			data: {
				renames: [],
				tool_alias: { old: 'run_agent', new: 'create_session' },
				dropped_keys: ['config', 'timeout_seconds'],
			},
		})
	})

	it('fans out to PostHog as mcp_alias_use after the Postgres write', async () => {
		await post(aliasBody(), { actorId: 'key-owner-actor' })

		expect(capturePosthogEvent).toHaveBeenCalledWith(
			'mcp_alias_use',
			'key-owner-actor',
			expect.objectContaining({
				workspace_id: wsId,
				agent_actor_id: 'key-owner-actor',
				tool_name: 'update_actor',
				renames: JSON.stringify([{ old: 'driver_id', new: 'driver' }]),
			}),
		)
	})

	it('returns 403 and writes no row for a caller who is not a workspace member', async () => {
		const { res, inserts } = await post(aliasBody(), { member: false })

		expect(res.status).toBe(403)
		expect(inserts).toHaveLength(0)
		expect(capturePosthogEvent).not.toHaveBeenCalled()
	})

	it('returns 400 and writes no row when a rename path carries free text', async () => {
		const { res, inserts } = await post(
			aliasBody({ renames: [{ old: 'Acquire the Nakatomi account', new: 'driver' }] }),
		)

		expect(res.status).toBe(400)
		expect(inserts).toHaveLength(0)
	})

	it('still answers 202 and fans out when the Postgres write fails', async () => {
		const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
		mockResults.select = [memberRow]
		mockResults.insertErrorQueue = [new Error('db down')]

		const res = await app.request(
			jsonRequest('POST', '/api/telemetry/mcp', aliasBody(), { 'x-workspace-id': wsId }),
		)

		expect(res.status).toBe(202)
		expect(capturePosthogEvent).toHaveBeenCalledTimes(1)
	})
})
