import { WIDGET_CATALOG, resolveWidget } from '@/mcp-apps/shared/widgets'
import { describe, expect, it } from 'vitest'

const obj = (overrides: Record<string, unknown> = {}) => ({
	id: 'id',
	type: 'task',
	status: 'todo',
	title: 't',
	...overrides,
})

const event = (overrides: Record<string, unknown> = {}) => ({
	id: 1,
	action: 'object.created',
	entityType: 'task',
	entityId: 'a',
	...overrides,
})

describe('WIDGET_CATALOG', () => {
	it('exposes a stable set of widgets', () => {
		expect(WIDGET_CATALOG.map((c) => c.kind)).toEqual([
			'relationship_graph',
			'activity_feed',
			'object_card',
			'object_kanban',
			'object_list_table',
		])
	})
})

describe('resolveWidget', () => {
	it('matches a graph payload', () => {
		expect(
			resolveWidget({
				toolName: 'create_objects',
				data: { nodes: [], edges: [] },
			}),
		).toBe('relationship_graph')
	})

	it('matches activity by tool name', () => {
		expect(resolveWidget({ toolName: 'get_events', data: [] })).toBe('activity_feed')
	})

	it('matches activity by payload shape', () => {
		expect(resolveWidget({ toolName: 'other', data: [event()] })).toBe('activity_feed')
	})

	it('matches a single object as a card', () => {
		expect(resolveWidget({ toolName: 'get_objects', data: obj() })).toBe('object_card')
		expect(resolveWidget({ toolName: 'get_objects', data: [obj()] })).toBe('object_card')
	})

	it('promotes single-type lists with repeated statuses to kanban', () => {
		expect(
			resolveWidget({
				toolName: 'list_objects',
				data: [
					obj({ id: 'a', status: 'todo' }),
					obj({ id: 'b', status: 'todo' }),
					obj({ id: 'c', status: 'done' }),
				],
			}),
		).toBe('object_kanban')
	})

	it('falls back to list table for heterogeneous lists', () => {
		expect(
			resolveWidget({
				toolName: 'search_objects',
				data: [
					obj({ id: 'a', type: 'task' }),
					obj({ id: 'b', type: 'bet' }),
					obj({ id: 'c', type: 'insight' }),
				],
			}),
		).toBe('object_list_table')
	})

	it('returns null when nothing matches', () => {
		expect(resolveWidget({ toolName: 'unknown', data: 'just a string' })).toBeNull()
	})

	it('unwraps the { data } envelope', () => {
		expect(
			resolveWidget({
				toolName: 'list_objects',
				data: { data: [obj({ id: 'a' })] },
			}),
		).toBe('object_card')
	})
})
