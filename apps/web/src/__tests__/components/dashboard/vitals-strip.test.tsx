import {
	bucketDecisionsPerInterval,
	countAgentStatuses,
	sessionsWithin,
} from '@/components/dashboard/vitals-strip'
import { groupSessionsByAgent } from '@/lib/agent-status'
import type { NotificationResponse, SessionResponse } from '@/lib/api'
import { describe, expect, it } from 'vitest'

function buildSession(overrides: Partial<SessionResponse> = {}): SessionResponse {
	return {
		id: 'session-1',
		workspaceId: 'ws-1',
		actorId: 'agent-1',
		triggerId: null,
		status: 'completed',
		containerId: null,
		actionPrompt: 'do thing',
		config: null,
		result: null,
		snapshotPath: null,
		startedAt: null,
		completedAt: null,
		timeoutAt: null,
		createdBy: 'human',
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

function buildNotification(overrides: Partial<NotificationResponse> = {}): NotificationResponse {
	return {
		id: 'notif-1',
		workspaceId: 'ws-1',
		type: 'needs_input',
		title: 'Decision needed',
		content: null,
		metadata: null,
		sourceActorId: 'agent-1',
		targetActorId: null,
		objectId: null,
		sessionId: null,
		status: 'resolved',
		resolvedAt: null,
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

describe('countAgentStatuses', () => {
	it('counts working / idle / failed across all agent ids', () => {
		const sessions = [
			buildSession({
				id: 's1',
				actorId: 'a',
				status: 'running',
				createdAt: '2026-04-26T10:00:00Z',
			}),
			buildSession({
				id: 's2',
				actorId: 'b',
				status: 'failed',
				createdAt: '2026-04-26T10:00:00Z',
			}),
		]
		const map = groupSessionsByAgent(sessions)
		const counts = countAgentStatuses(['a', 'b', 'c'], map)
		expect(counts).toEqual({ working: 1, idle: 1, failed: 1 })
	})

	it('treats agents with no sessions as idle', () => {
		const counts = countAgentStatuses(['a', 'b'], new Map())
		expect(counts).toEqual({ working: 0, idle: 2, failed: 0 })
	})
})

describe('sessionsWithin', () => {
	const now = Date.parse('2026-04-26T12:00:00Z')

	it('keeps only sessions whose createdAt falls inside the window', () => {
		const sessions = [
			buildSession({ id: 'recent', createdAt: '2026-04-26T11:00:00Z' }),
			buildSession({ id: 'old', createdAt: '2026-04-25T11:00:00Z' }),
			buildSession({ id: 'no-time', createdAt: null }),
		]
		const within = sessionsWithin(sessions, now, 24 * 60 * 60 * 1000)
		expect(within.map((s) => s.id)).toEqual(['recent'])
	})

	it('drops sessions whose createdAt is unparseable', () => {
		const sessions = [buildSession({ id: 'garbled', createdAt: 'not-a-date' })]
		expect(sessionsWithin(sessions, now, 24 * 60 * 60 * 1000)).toEqual([])
	})
})

describe('bucketDecisionsPerInterval', () => {
	const now = Date.parse('2026-04-26T12:00:00Z')

	it('drops decisions resolved before the window', () => {
		const resolved = [buildNotification({ resolvedAt: '2026-04-26T10:30:00Z' })]
		expect(bucketDecisionsPerInterval(resolved, now, 6, 10 * 60 * 1000)).toEqual([0, 0, 0, 0, 0, 0])
	})

	it('places decisions in the correct bucket and clamps the most recent into the last slot', () => {
		const resolved = [
			buildNotification({ id: 'b1', resolvedAt: '2026-04-26T11:05:00Z' }), // 55 min ago → bucket 0
			buildNotification({ id: 'b2', resolvedAt: '2026-04-26T11:35:00Z' }), // 25 min ago → bucket 3
			buildNotification({ id: 'b3', resolvedAt: '2026-04-26T12:00:00Z' }), // exactly now → last bucket
		]
		expect(bucketDecisionsPerInterval(resolved, now, 6, 10 * 60 * 1000)).toEqual([1, 0, 0, 1, 0, 1])
	})

	it('ignores decisions with no resolvedAt or unparseable timestamps', () => {
		const resolved = [
			buildNotification({ id: 'n1', resolvedAt: null }),
			buildNotification({ id: 'n2', resolvedAt: 'broken' }),
		]
		expect(
			bucketDecisionsPerInterval(resolved, now, 3, 60 * 60 * 1000).reduce((a, b) => a + b, 0),
		).toBe(0)
	})
})
