import {
	NODE_PAGE_SIZE,
	extractFirstObjectGraph,
	parseGraphResult,
} from '@/mcp-apps/graph/extractors'
import { describe, expect, it } from 'vitest'

describe('parseGraphResult', () => {
	it('parses a valid graph payload', () => {
		const payload = JSON.stringify({
			nodes: [{ id: 'n1', type: 'task', title: 'Hello', status: 'todo' }],
			edges: [{ id: 'e1', source: 'n1', target: 'n2', type: 'relates_to' }],
		})
		expect(parseGraphResult(payload)).toEqual({
			nodes: [{ id: 'n1', type: 'task', title: 'Hello', status: 'todo' }],
			edges: [{ id: 'e1', source: 'n1', target: 'n2', type: 'relates_to' }],
		})
	})

	it('returns null when input is not JSON', () => {
		expect(parseGraphResult('not json')).toBeNull()
	})

	it('returns null when nodes/edges are missing', () => {
		expect(parseGraphResult(JSON.stringify({}))).toBeNull()
		expect(parseGraphResult(JSON.stringify({ nodes: [] }))).toBeNull()
		expect(parseGraphResult(JSON.stringify({ edges: [] }))).toBeNull()
	})

	it('drops malformed nodes and edges silently', () => {
		const payload = JSON.stringify({
			nodes: [
				{ id: 'n1', type: 'task', title: null, status: 'todo' },
				{ id: 'broken' }, // missing type/status
				null,
			],
			edges: [
				{ id: 'e1', source: 'n1', target: 'n2', type: 'relates_to' },
				{ id: 'broken-edge' }, // missing source/target/type
			],
		})
		const result = parseGraphResult(payload)
		expect(result?.nodes).toHaveLength(1)
		expect(result?.edges).toHaveLength(1)
	})
})

describe('extractFirstObjectGraph', () => {
	it('returns the first successful object graph bundle', () => {
		const payload = [
			{
				success: true,
				result: {
					object: { id: 'o1', type: 'task', title: 'A', status: 'todo' },
					relationships: [{ id: 'r1', sourceId: 'o1', targetId: 'o2', type: 'relates_to' }],
					connected_objects: [{ id: 'o2', type: 'task', title: 'B', status: 'done' }],
				},
			},
		]
		expect(extractFirstObjectGraph(payload)).toEqual(payload[0].result)
	})

	it('skips failed entries', () => {
		const a = {
			object: { id: 'o1', type: 'task', title: null, status: 'todo' },
			relationships: [],
			connected_objects: [],
		}
		const payload = [{ success: false }, { success: true, result: a }]
		expect(extractFirstObjectGraph(payload)).toEqual(a)
	})

	it('defaults relationships and connected_objects to empty arrays', () => {
		const payload = [
			{
				success: true,
				result: { object: { id: 'o1', type: 'task', title: null, status: 'todo' } },
			},
		]
		const result = extractFirstObjectGraph(payload)
		expect(result?.relationships).toEqual([])
		expect(result?.connected_objects).toEqual([])
	})

	it('returns null for non-array input', () => {
		expect(extractFirstObjectGraph(null)).toBeNull()
		expect(extractFirstObjectGraph({})).toBeNull()
	})
})

describe('NODE_PAGE_SIZE', () => {
	it('is a sensible positive page size', () => {
		expect(NODE_PAGE_SIZE).toBeGreaterThan(0)
		expect(NODE_PAGE_SIZE).toBeLessThanOrEqual(100)
	})
})
