import { buildFleetSections, classifyFleetRow } from '@/components/objects/fleet-status-view'
import type { ObjectResponse } from '@/lib/api'
import type { BetStatusResult, BetStatusState } from '@/lib/bet-status'
import { describe, expect, it } from 'vitest'

const NOW = new Date('2026-07-21T12:00:00Z')

function obj(overrides: Partial<ObjectResponse> & { id: string; type: string }): ObjectResponse {
	return {
		workspaceId: 'ws-1',
		title: `Object ${overrides.id}`,
		content: null,
		status: 'todo',
		metadata: null,
		driver: null,
		activeSessionId: null,
		createdBy: 'actor-1',
		createdAt: NOW.toISOString(),
		updatedAt: NOW.toISOString(),
		...overrides,
	}
}

function betResult(state: BetStatusState): BetStatusResult {
	return { state, pendingAction: null, decisionsSoFar: [] }
}

describe('classifyFleetRow', () => {
	it('reads bet state from the bet-statuses map', () => {
		const bet = obj({ id: 'b1', type: 'bet' })
		const map = new Map<string, BetStatusResult>([['b1', betResult('waiting_on_human')]])
		expect(classifyFleetRow(bet, map, NOW)).toBe('waiting_on_human')
	})

	it('falls back to idle when a bet is missing from the map', () => {
		expect(classifyFleetRow(obj({ id: 'b1', type: 'bet' }), new Map(), NOW)).toBe('idle')
	})

	it('classifies non-bet rows via classifyObjectStatus', () => {
		const task = obj({
			id: 't1',
			type: 'task',
			status: 'todo',
			metadata: { human_decision: true },
		})
		expect(classifyFleetRow(task, new Map(), NOW)).toBe('waiting_on_human')
	})
})

describe('buildFleetSections', () => {
	it('returns three sections in order Insight → Bet → Task', () => {
		const objects: ObjectResponse[] = []
		const sections = buildFleetSections(objects, new Map(), NOW)
		expect(sections.map((s) => s.type)).toEqual(['insight', 'bet', 'task'])
		for (const s of sections) expect(s.totalCount).toBe(0)
	})

	it('groups objects by primitive and ignores unrecognised types', () => {
		const objects = [
			obj({ id: 'i1', type: 'insight' }),
			obj({ id: 'b1', type: 'bet' }),
			obj({ id: 't1', type: 'task' }),
			obj({ id: 'k1', type: 'knowledge' }),
		]
		const sections = buildFleetSections(objects, new Map(), NOW)
		expect(sections.find((s) => s.type === 'insight')?.totalCount).toBe(1)
		expect(sections.find((s) => s.type === 'bet')?.totalCount).toBe(1)
		expect(sections.find((s) => s.type === 'task')?.totalCount).toBe(1)
	})

	it('sorts rows within each section: waiting → stalled → progressing → idle', () => {
		const bets = [
			obj({ id: 'b-idle', type: 'bet' }),
			obj({ id: 'b-progressing', type: 'bet' }),
			obj({ id: 'b-waiting', type: 'bet' }),
			obj({ id: 'b-stalled', type: 'bet' }),
		]
		const betStatuses = new Map<string, BetStatusResult>([
			['b-idle', betResult('idle')],
			['b-progressing', betResult('progressing')],
			['b-waiting', betResult('waiting_on_human')],
			['b-stalled', betResult('stalled')],
		])
		const sections = buildFleetSections(bets, betStatuses, NOW)
		const betSection = sections.find((s) => s.type === 'bet')
		expect(betSection?.rows.map((r) => r.state)).toEqual([
			'waiting_on_human',
			'stalled',
			'progressing',
			'idle',
		])
	})

	it('reports the waiting count and drops it to zero when the row is not waiting', () => {
		const bets = [obj({ id: 'b1', type: 'bet' })]
		const waitingMap = new Map<string, BetStatusResult>([['b1', betResult('waiting_on_human')]])
		const idleMap = new Map<string, BetStatusResult>([['b1', betResult('idle')]])
		const waitingSection = buildFleetSections(bets, waitingMap, NOW).find((s) => s.type === 'bet')
		const idleSection = buildFleetSections(bets, idleMap, NOW).find((s) => s.type === 'bet')
		expect(waitingSection?.waitingCount).toBe(1)
		expect(idleSection?.waitingCount).toBe(0)
	})

	it('reports the idle count so the idle-fold disclosure knows what to reveal', () => {
		const tasks = [
			obj({ id: 't1', type: 'task', status: 'done' }),
			obj({ id: 't2', type: 'task', status: 'todo', metadata: { human_decision: true } }),
			obj({ id: 't3', type: 'task', status: 'in_progress', activeSessionId: 'sess-1' }),
		]
		const sections = buildFleetSections(tasks, new Map(), NOW)
		const taskSection = sections.find((s) => s.type === 'task')
		expect(taskSection?.totalCount).toBe(3)
		expect(taskSection?.idleCount).toBe(1)
		expect(taskSection?.waitingCount).toBe(1)
		expect(taskSection?.activeCount).toBe(2)
	})

	it('breaks ties inside a state by most-recently-updated first', () => {
		const older = new Date(NOW.getTime() - 3_600_000).toISOString()
		const newer = new Date(NOW.getTime() - 60_000).toISOString()
		const insights = [
			obj({ id: 'i-old', type: 'insight', updatedAt: older }),
			obj({ id: 'i-new', type: 'insight', updatedAt: newer }),
		]
		const sections = buildFleetSections(insights, new Map(), NOW)
		const ids = sections.find((s) => s.type === 'insight')?.rows.map((r) => r.obj.id)
		expect(ids).toEqual(['i-new', 'i-old'])
	})
})
