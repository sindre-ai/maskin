import { createGraphSchema } from '@ai-native/shared'
import { describe, expect, it } from 'vitest'

describe('Graph schema validation', () => {
	it('accepts a single node with no edges', () => {
		const result = createGraphSchema.safeParse({
			nodes: [{ $id: 'bet-1', type: 'bet', title: 'Improve onboarding', status: 'active' }],
		})
		expect(result.success).toBe(true)
		expect(result.data?.edges).toEqual([])
	})

	it('accepts nodes with edges referencing $ids', () => {
		const result = createGraphSchema.safeParse({
			nodes: [
				{ $id: 'bet-1', type: 'bet', title: 'Improve onboarding', status: 'active' },
				{ $id: 'task-1', type: 'task', title: 'Add welcome wizard', status: 'todo' },
				{ $id: 'task-2', type: 'task', title: 'Write docs', status: 'todo' },
			],
			edges: [
				{ source: 'bet-1', target: 'task-1', type: 'breaks_into' },
				{ source: 'bet-1', target: 'task-2', type: 'breaks_into' },
			],
		})
		expect(result.success).toBe(true)
		expect(result.data?.nodes).toHaveLength(3)
		expect(result.data?.edges).toHaveLength(2)
	})

	it('accepts edges referencing existing UUIDs', () => {
		const result = createGraphSchema.safeParse({
			nodes: [{ $id: 'task-1', type: 'task', title: 'New task', status: 'todo' }],
			edges: [
				{
					source: '550e8400-e29b-41d4-a716-446655440000',
					target: 'task-1',
					type: 'breaks_into',
				},
			],
		})
		expect(result.success).toBe(true)
	})

	it('accepts nodes with metadata', () => {
		const result = createGraphSchema.safeParse({
			nodes: [
				{
					$id: 'insight-1',
					type: 'insight',
					title: 'User feedback',
					status: 'new',
					metadata: { source: 'survey', confidence: 0.9 },
				},
			],
		})
		expect(result.success).toBe(true)
	})

	it('rejects empty nodes array', () => {
		const result = createGraphSchema.safeParse({
			nodes: [],
			edges: [],
		})
		expect(result.success).toBe(false)
	})

	it('rejects invalid object type', () => {
		const result = createGraphSchema.safeParse({
			nodes: [{ $id: 'x', type: 'invalid', status: 'new' }],
		})
		expect(result.success).toBe(false)
	})

	it('rejects missing $id on nodes', () => {
		const result = createGraphSchema.safeParse({
			nodes: [{ type: 'bet', status: 'active' }],
		})
		expect(result.success).toBe(false)
	})

	it('rejects missing status on nodes', () => {
		const result = createGraphSchema.safeParse({
			nodes: [{ $id: 'bet-1', type: 'bet' }],
		})
		expect(result.success).toBe(false)
	})

	it('rejects edges with missing type', () => {
		const result = createGraphSchema.safeParse({
			nodes: [
				{ $id: 'a', type: 'bet', status: 'active' },
				{ $id: 'b', type: 'task', status: 'todo' },
			],
			edges: [{ source: 'a', target: 'b' }],
		})
		expect(result.success).toBe(false)
	})

	it('accepts insight→bet→task graph', () => {
		const result = createGraphSchema.safeParse({
			nodes: [
				{
					$id: 'i1',
					type: 'insight',
					title: 'Users want dark mode',
					status: 'new',
				},
				{
					$id: 'b1',
					type: 'bet',
					title: 'Build dark mode',
					status: 'active',
				},
				{
					$id: 't1',
					type: 'task',
					title: 'Implement theme toggle',
					status: 'todo',
				},
			],
			edges: [
				{ source: 'i1', target: 'b1', type: 'informs' },
				{ source: 'b1', target: 't1', type: 'breaks_into' },
			],
		})
		expect(result.success).toBe(true)
	})
})
