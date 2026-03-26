import { describe, expect, it } from 'vitest'
import { createGraphSchema, graphEdgeSchema, graphNodeSchema } from '../schemas/graph'

const uuid = '550e8400-e29b-41d4-a716-446655440000'

describe('graphNodeSchema', () => {
	it('accepts valid node', () => {
		const result = graphNodeSchema.parse({
			$id: 'bet-1',
			type: 'bet',
			status: 'active',
		})
		expect(result.$id).toBe('bet-1')
		expect(result.type).toBe('bet')
	})

	it('accepts all optional fields', () => {
		const result = graphNodeSchema.parse({
			$id: 'task-1',
			type: 'task',
			status: 'todo',
			title: 'My task',
			content: 'Details',
			metadata: { priority: 'high' },
			owner: uuid,
		})
		expect(result.title).toBe('My task')
		expect(result.owner).toBe(uuid)
	})

	it('rejects missing $id', () => {
		expect(() => graphNodeSchema.parse({ type: 'bet', status: 'active' })).toThrow()
	})

	it('rejects missing type', () => {
		expect(() => graphNodeSchema.parse({ $id: 'x', status: 'active' })).toThrow()
	})

	it('rejects missing status', () => {
		expect(() => graphNodeSchema.parse({ $id: 'x', type: 'bet' })).toThrow()
	})

	it('accepts any non-empty string type', () => {
		const result = graphNodeSchema.parse({ $id: 'x', type: 'meeting', status: 'scheduled' })
		expect(result.type).toBe('meeting')
	})

	it('rejects empty type', () => {
		expect(() => graphNodeSchema.parse({ $id: 'x', type: '', status: 'a' })).toThrow()
	})
})

describe('graphEdgeSchema', () => {
	it('accepts valid edge', () => {
		const result = graphEdgeSchema.parse({
			source: 'bet-1',
			target: 'task-1',
			type: 'breaks_into',
		})
		expect(result.source).toBe('bet-1')
		expect(result.type).toBe('breaks_into')
	})

	it('accepts uuid strings', () => {
		const result = graphEdgeSchema.parse({ source: uuid, target: uuid, type: 'informs' })
		expect(result.source).toBe(uuid)
	})

	it('rejects missing source', () => {
		expect(() => graphEdgeSchema.parse({ target: 'x', type: 'y' })).toThrow()
	})

	it('rejects missing target', () => {
		expect(() => graphEdgeSchema.parse({ source: 'x', type: 'y' })).toThrow()
	})

	it('rejects missing type', () => {
		expect(() => graphEdgeSchema.parse({ source: 'x', target: 'y' })).toThrow()
	})
})

describe('createGraphSchema', () => {
	it('accepts nodes with edges', () => {
		const result = createGraphSchema.parse({
			nodes: [
				{ $id: 'bet-1', type: 'bet', status: 'active' },
				{ $id: 'task-1', type: 'task', status: 'todo' },
			],
			edges: [{ source: 'bet-1', target: 'task-1', type: 'breaks_into' }],
		})
		expect(result.nodes).toHaveLength(2)
		expect(result.edges).toHaveLength(1)
	})

	it('defaults edges to empty array', () => {
		const result = createGraphSchema.parse({
			nodes: [{ $id: 'bet-1', type: 'bet', status: 'active' }],
		})
		expect(result.edges).toEqual([])
	})

	it('rejects empty nodes array', () => {
		expect(() => createGraphSchema.parse({ nodes: [] })).toThrow()
	})

	it('rejects more than 50 nodes', () => {
		const nodes = Array.from({ length: 51 }, (_, i) => ({
			$id: `node-${i}`,
			type: 'task' as const,
			status: 'todo',
		}))
		expect(() => createGraphSchema.parse({ nodes })).toThrow()
	})

	it('accepts exactly 50 nodes', () => {
		const nodes = Array.from({ length: 50 }, (_, i) => ({
			$id: `node-${i}`,
			type: 'task' as const,
			status: 'todo',
		}))
		const result = createGraphSchema.parse({ nodes })
		expect(result.nodes).toHaveLength(50)
	})

	it('rejects more than 100 edges', () => {
		const nodes = [{ $id: 'n', type: 'task' as const, status: 'todo' }]
		const edges = Array.from({ length: 101 }, () => ({
			source: 'n',
			target: 'n',
			type: 'relates_to',
		}))
		expect(() => createGraphSchema.parse({ nodes, edges })).toThrow()
	})
})
