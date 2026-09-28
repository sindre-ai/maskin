import { queryKeys } from '@/lib/query-keys'
import { invalidateFromSSE } from '@/lib/sse-invalidation'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/analytics', () => ({
	trackTriggerFired: vi.fn(),
	trackAgentSessionCompleted: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
	api: {
		sessions: { get: vi.fn() },
	},
}))

import { trackAgentSessionCompleted, trackTriggerFired } from '@/lib/analytics'
import { api } from '@/lib/api'

function createMockQueryClient() {
	return {
		invalidateQueries: vi.fn(),
	}
}

const workspaceId = 'ws-1'
const entityId = 'entity-1'

beforeEach(() => {
	vi.clearAllMocks()
})

describe('invalidateFromSSE', () => {
	it('always invalidates events history and byEntity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'task',
			entity_id: entityId,
			action: 'created',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.events.history(workspaceId),
		})
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.events.byEntity(entityId),
		})
	})

	it('invalidates objects for task entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'task',
			entity_id: entityId,
			action: 'created',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.objects.all(workspaceId),
		})
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.objects.detail(entityId),
		})
	})

	it('invalidates objects and bets for bet entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'bet',
			entity_id: entityId,
			action: 'updated',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.bets.all(workspaceId),
		})
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.objects.all(workspaceId),
		})
	})

	it('invalidates objects for insight entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'insight',
			entity_id: entityId,
			action: 'created',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.objects.all(workspaceId),
		})
	})

	it('invalidates objects for loop entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'loop',
			entity_id: entityId,
			action: 'status_changed',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.objects.all(workspaceId),
		})
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.objects.detail(entityId),
		})
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.objects.graph(entityId),
		})
		expect(qc.invalidateQueries).not.toHaveBeenCalledWith({
			queryKey: queryKeys.bets.all(workspaceId),
		})
	})

	it('invalidates objects for knowledge entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'knowledge',
			entity_id: entityId,
			action: 'updated',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.objects.all(workspaceId),
		})
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.objects.detail(entityId),
		})
	})

	it('invalidates relationships for relationship entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'relationship',
			entity_id: entityId,
			action: 'created',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.relationships.all(workspaceId),
		})
	})

	it('invalidates triggers for trigger entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'trigger',
			entity_id: entityId,
			action: 'updated',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.triggers.all(workspaceId),
		})
	})

	it('invalidates all sessions for session entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'session',
			entity_id: entityId,
			action: 'updated',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: ['sessions'],
		})
	})

	it('invalidates notifications for notification entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'notification',
			entity_id: entityId,
			action: 'created',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.notifications.all(workspaceId),
		})
	})

	it('invalidates actors for actor entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'actor',
			entity_id: entityId,
			action: 'updated',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.actors.all(workspaceId),
		})
	})

	it('invalidates workspaces for workspace entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'workspace',
			entity_id: entityId,
			action: 'updated',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.workspaces.all(),
		})
	})

	it('invalidates workspace skills for workspace_skill entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'workspace_skill',
			entity_id: entityId,
			action: 'created',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.workspaceSkills.all(workspaceId),
		})
	})

	it('invalidates all agent skill attachments for agent_skill entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'agent_skill',
			entity_id: entityId,
			action: 'attached',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: ['agent-skill-attachments'],
		})
	})

	it('emits trigger_fired analytics when a trigger entity carries the fire action', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'trigger',
			entity_id: 'trg-1',
			action: 'trigger_fired',
			event_id: 'evt-1',
		} as never)
		expect(trackTriggerFired).toHaveBeenCalledWith({
			entity_id: 'trg-1',
			entity_type: 'trigger',
			flow_id: 'evt-1',
		})
	})

	it('does not emit trigger_fired for other trigger actions', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'trigger',
			entity_id: 'trg-1',
			action: 'updated',
		} as never)
		expect(trackTriggerFired).not.toHaveBeenCalled()
	})

	it('emits agent_session_completed on completed/failed/timeout actions with outcome', async () => {
		const session = { triggerId: null, config: {} }
		vi.mocked(api.sessions.get).mockResolvedValue(session as never)

		const qc = createMockQueryClient()
		for (const [action, outcome] of [
			['session_completed', 'completed'],
			['session_failed', 'failed'],
			['session_timeout', 'timeout'],
		] as const) {
			invalidateFromSSE(qc as never, workspaceId, {
				entity_type: 'session',
				entity_id: 'sess-1',
				action,
				event_id: 'evt-2',
			} as never)
		}
		await vi.waitFor(() => expect(trackAgentSessionCompleted).toHaveBeenCalledTimes(3))
		expect(trackAgentSessionCompleted).toHaveBeenNthCalledWith(1, {
			entity_id: 'sess-1',
			entity_type: 'session',
			outcome: 'completed',
			flow_id: 'evt-2',
			trigger_id: null,
			trigger_type: null,
		})
		expect(trackAgentSessionCompleted).toHaveBeenNthCalledWith(2, {
			entity_id: 'sess-1',
			entity_type: 'session',
			outcome: 'failed',
			flow_id: 'evt-2',
			trigger_id: null,
			trigger_type: null,
		})
		expect(trackAgentSessionCompleted).toHaveBeenNthCalledWith(3, {
			entity_id: 'sess-1',
			entity_type: 'session',
			outcome: 'timeout',
			flow_id: 'evt-2',
			trigger_id: null,
			trigger_type: null,
		})
	})

	it('forwards the session row trigger_id and config.trigger_type as G2 provenance', async () => {
		vi.mocked(api.sessions.get).mockResolvedValue({
			triggerId: 'trig-1',
			config: { trigger_type: 'cron' },
		} as never)

		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'session',
			entity_id: 'sess-9',
			action: 'session_completed',
			event_id: 'evt-9',
		} as never)

		await vi.waitFor(() => expect(trackAgentSessionCompleted).toHaveBeenCalledOnce())
		expect(trackAgentSessionCompleted).toHaveBeenCalledWith({
			entity_id: 'sess-9',
			entity_type: 'session',
			outcome: 'completed',
			flow_id: 'evt-9',
			trigger_id: 'trig-1',
			trigger_type: 'cron',
		})
	})

	it('still emits the completion without provenance when the session row cannot be read', async () => {
		vi.mocked(api.sessions.get).mockRejectedValueOnce(new Error('404 not found'))

		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'session',
			entity_id: 'sess-gone',
			action: 'session_completed',
			event_id: 'evt-10',
		} as never)

		await vi.waitFor(() => expect(trackAgentSessionCompleted).toHaveBeenCalledOnce())
		expect(trackAgentSessionCompleted).toHaveBeenCalledWith({
			entity_id: 'sess-gone',
			entity_type: 'session',
			outcome: 'completed',
			flow_id: 'evt-10',
			trigger_id: null,
			trigger_type: null,
		})
	})

	it('does not emit agent_session_completed for routine session updates', async () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'session',
			entity_id: 'sess-1',
			action: 'updated',
		} as never)
		await Promise.resolve()
		expect(api.sessions.get).not.toHaveBeenCalled()
		expect(trackAgentSessionCompleted).not.toHaveBeenCalled()
	})
})
