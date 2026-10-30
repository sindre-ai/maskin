import { describe, expect, it, vi } from 'vitest'
import { recordMcpAliasUse } from '../../lib/analytics/mcp-alias'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn(),
}))

const wsId = '00000000-0000-0000-0000-000000000001'

const event = {
	toolName: 'get_objects',
	sessionId: 'mcp-abc',
	transport: 'stdio' as const,
	renames: [{ old: 'id', new: 'ids' }],
	bothSent: false,
	droppedKeys: [],
	toolAlias: null,
	agentActorId: 'actor-1',
}

describe('recordMcpAliasUse', () => {
	it('persists to mcp_telemetry with event_type=alias_use and never throws on DB failure', async () => {
		const insertValues = vi.fn().mockRejectedValue(new Error('db down'))
		const db = { insert: vi.fn().mockReturnValue({ values: insertValues }) } as never

		await expect(recordMcpAliasUse(db, wsId, event)).resolves.toBeUndefined()
		expect(insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: wsId,
				eventType: 'alias_use',
				toolName: 'get_objects',
				sessionId: 'mcp-abc',
				data: expect.objectContaining({
					renames: [{ old: 'id', new: 'ids' }],
					both_sent: false,
					agent_actor_id: 'actor-1',
					transport: 'stdio',
				}),
			}),
		)
	})

	it('writes Postgres before it calls PostHog', async () => {
		const { capturePosthogEvent } = await import('../../lib/analytics/posthog')
		vi.mocked(capturePosthogEvent).mockClear()
		const order: string[] = []
		const insertValues = vi.fn().mockImplementation(async () => {
			order.push('postgres')
		})
		vi.mocked(capturePosthogEvent).mockImplementation(async () => {
			order.push('posthog')
		})
		const db = { insert: vi.fn().mockReturnValue({ values: insertValues }) } as never

		await recordMcpAliasUse(db, wsId, event)

		expect(order).toEqual(['postgres', 'posthog'])
	})

	it('skips the DB write when db is undefined (still fans out to PostHog)', async () => {
		const { capturePosthogEvent } = await import('../../lib/analytics/posthog')
		vi.mocked(capturePosthogEvent).mockClear()

		await recordMcpAliasUse(undefined, wsId, {
			...event,
			toolName: 'run_agent',
			renames: [],
			droppedKeys: ['config'],
			toolAlias: { old: 'run_agent', new: 'create_session' },
		})

		expect(capturePosthogEvent).toHaveBeenCalledWith(
			'mcp_alias_use',
			'actor-1',
			expect.objectContaining({
				tool_name: 'run_agent',
				dropped_keys: JSON.stringify(['config']),
				tool_alias: JSON.stringify({ old: 'run_agent', new: 'create_session' }),
			}),
		)
	})

	it('falls back to the workspace as the PostHog distinct id when the actor is unknown', async () => {
		const { capturePosthogEvent } = await import('../../lib/analytics/posthog')
		vi.mocked(capturePosthogEvent).mockClear()

		await recordMcpAliasUse(undefined, wsId, { ...event, agentActorId: null })

		expect(capturePosthogEvent).toHaveBeenCalledWith('mcp_alias_use', wsId, expect.anything())
	})
})
