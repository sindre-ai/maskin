import { describe, expect, it } from 'vitest'
import { buildSyntheticGraph } from '../parallel-bet-autonomy'

// Smoke test on the synthetic graph shape. The harness only runs end-to-end
// on a weekly schedule, so a silent drift in this graph (a dropped task, a
// missing breaks_into edge, an untagged object) would otherwise sit
// unnoticed for days. This locks the diamond + tagging contract.
describe('buildSyntheticGraph', () => {
	const graph = buildSyntheticGraph()

	it('emits 1 bet + 4 tasks with the expected $ids', () => {
		expect(graph.nodes).toHaveLength(5)

		const byId = new Map(graph.nodes.map((n) => [n.$id, n]))
		expect([...byId.keys()].sort()).toEqual(['bet', 't1', 't2', 't3', 't4'])

		expect(byId.get('bet')?.type).toBe('bet')
		for (const taskId of ['t1', 't2', 't3', 't4'] as const) {
			expect(byId.get(taskId)?.type).toBe('task')
		}
	})

	it('emits exactly 4 breaks_into edges sourced at the bet, one per task', () => {
		expect(graph.edges).toHaveLength(4)
		for (const edge of graph.edges) {
			expect(edge.type).toBe('breaks_into')
			expect(edge.source).toBe('bet')
		}
		const targets = graph.edges.map((e) => e.target).sort()
		expect(targets).toEqual(['t1', 't2', 't3', 't4'])
	})

	it('tags every synthetic object with synthetic_e2e: true and a shared run id', () => {
		const runIds = new Set<unknown>()
		for (const node of graph.nodes) {
			expect(node.metadata?.synthetic_e2e).toBe(true)
			runIds.add(node.metadata?.synthetic_run_id)
		}
		// All nodes built in one buildSyntheticGraph() call share one run id —
		// any divergence would mean the bet and its tasks couldn't be
		// correlated post-hoc by run.
		expect(runIds.size).toBe(1)
		expect(typeof [...runIds][0]).toBe('string')
	})
})
