import { readFileSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ALIASES } from '../aliases'
import { REMOVAL_LEDGER } from '../removal-ledger'
import { type AliasHarness, startAliasHarness } from './helpers/alias-harness'
import { type SurfaceMap, buildSurface, findUncoveredRemovals } from './helpers/surface-guard'

// See aliases.test.ts: keep the stdio entry point of ../server from listening
// on this process's stdin.
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
	StdioServerTransport: class {
		onmessage?: unknown
		onclose?: unknown
		onerror?: unknown
		async start() {}
		async send() {}
		async close() {}
	},
}))

// The removal guard. surface-snapshot.json lists every tool name and parameter
// path the server advertised when it was last regenerated. This test fails when
// an entry has left the live surface without either:
//   - a live alias row for it in src/aliases.ts, or
//   - an entry in src/removal-ledger.ts that carries a sweep date.
//
// Changing the snapshot on purpose is the one place a removal gets reviewed:
//   UPDATE_SURFACE_SNAPSHOT=1 pnpm --filter @maskin/mcp vitest run surface-guard
// Additions are fine and only need the snapshot refreshed when you want them pinned.
const SNAPSHOT_URL = new URL('./surface-snapshot.json', import.meta.url)

describe('surface removal guard', () => {
	let harness: AliasHarness
	let current: SurfaceMap

	beforeAll(async () => {
		harness = await startAliasHarness()
		current = buildSurface(await harness.listTools())
	})
	afterAll(async () => {
		await harness.close()
	})

	it('has no tool or parameter missing from the live surface without an alias row or ledger entry', () => {
		if (process.env.UPDATE_SURFACE_SNAPSHOT === '1') {
			writeFileSync(SNAPSHOT_URL, `${JSON.stringify({ tools: current }, null, '\t')}\n`)
			return
		}
		const snapshot = JSON.parse(readFileSync(SNAPSHOT_URL, 'utf8')) as { tools: SurfaceMap }
		expect(findUncoveredRemovals(snapshot.tools, current, ALIASES, REMOVAL_LEDGER)).toEqual([])
	})

	it('lists the live surface in the snapshot, so a refreshed snapshot is not a no-op', () => {
		const snapshot = JSON.parse(readFileSync(SNAPSHOT_URL, 'utf8')) as { tools: SurfaceMap }
		expect(Object.keys(snapshot.tools).length).toBeGreaterThan(50)
		expect(snapshot.tools.create_objects).toContain('edges.source')
	})
})

describe('findUncoveredRemovals', () => {
	const snapshot: SurfaceMap = {
		create_objects: ['edges', 'edges.source', 'edges.target', 'workspace_id'],
		get_objects: ['ids'],
	}

	it('passes when nothing is missing', () => {
		expect(findUncoveredRemovals(snapshot, snapshot, [], [])).toEqual([])
	})

	it('fails for a deleted parameter', () => {
		const current: SurfaceMap = { ...snapshot, get_objects: [] }
		expect(findUncoveredRemovals(snapshot, current, [], [])).toEqual([
			'get_objects parameter ids is gone with no live alias row or ledger entry',
		])
	})

	it('fails for a deleted tool', () => {
		const { get_objects: _gone, ...current } = snapshot
		expect(findUncoveredRemovals(snapshot, current, [], [])).toEqual([
			'tool get_objects is gone and has no removal ledger entry',
		])
	})

	it('passes a deleted parameter that has a live alias row for the old name', () => {
		const current: SurfaceMap = { ...snapshot, get_objects: [] }
		const aliases = [
			{ tool: 'get_objects', oldPath: 'ids', newPath: 'id', kind: 'rename' },
		] as const
		expect(findUncoveredRemovals(snapshot, current, aliases, [])).toEqual([])
	})

	it('passes a deleted parameter and its children when the ledger covers the parent', () => {
		const current: SurfaceMap = {
			...snapshot,
			create_objects: ['workspace_id'],
		}
		const ledger = [
			{
				tool: 'create_objects',
				path: 'edges',
				removed: '2026-01-01',
				sweepDate: '2026-02-01',
				decision: 'test',
			},
		]
		expect(findUncoveredRemovals(snapshot, current, [], ledger)).toEqual([])
	})

	it('passes a deleted tool that has a ledger entry', () => {
		const { get_objects: _gone, ...current } = snapshot
		const ledger = [
			{ tool: 'get_objects', removed: '2026-01-01', sweepDate: '2026-02-01', decision: 'test' },
		]
		expect(findUncoveredRemovals(snapshot, current, [], ledger)).toEqual([])
	})

	it('does not let a ledger entry for one tool cover another', () => {
		const current: SurfaceMap = { ...snapshot, get_objects: [] }
		const ledger = [
			{ tool: 'other', path: 'ids', removed: '2026-01-01', sweepDate: '2026-02-01', decision: 'x' },
		]
		expect(findUncoveredRemovals(snapshot, current, [], ledger)).toHaveLength(1)
	})
})

describe('removal ledger', () => {
	const DAY = /^\d{4}-\d{2}-\d{2}$/

	it('gives every entry a removal day, a sweep date and a decision', () => {
		for (const entry of REMOVAL_LEDGER) {
			expect(entry.removed, entry.tool).toMatch(DAY)
			expect(entry.sweepDate, entry.tool).toMatch(DAY)
			expect(entry.sweepDate >= entry.removed, entry.tool).toBe(true)
			expect(entry.decision.trim().length, entry.tool).toBeGreaterThan(0)
		}
	})

	it('records run_agent: removed 12 Oct 2026, sweep date 2026-10-15, restored as an alias', () => {
		const entry = REMOVAL_LEDGER.find((e) => e.tool === 'run_agent')
		expect(entry).toBeDefined()
		expect(entry?.removed).toBe('2026-10-12')
		expect(entry?.sweepDate).toBe('2026-10-15')
		expect(entry?.path).toBeUndefined()
		expect(entry?.decision).toContain('PR 1986')
		expect(entry?.decision).toContain('alias of create_session')
		expect(entry?.decision).toContain('D5')
	})
})
