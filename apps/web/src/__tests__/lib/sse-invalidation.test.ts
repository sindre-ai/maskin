import { queryKeys } from '@/lib/query-keys'
import { invalidateFromSSE } from '@/lib/sse-invalidation'
import { describe, expect, it, vi } from 'vitest'

function createMockQueryClient() {
	return {
		invalidateQueries: vi.fn(),
	}
}

const workspaceId = 'ws-1'
const entityId = 'entity-1'

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
})
