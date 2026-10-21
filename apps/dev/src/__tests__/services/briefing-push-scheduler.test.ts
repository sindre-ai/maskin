import type { Database } from '@maskin/db'
import {
	BriefingPushScheduler,
	type BriefingWorkspaceFacts,
	buildBriefingText,
} from '../../services/briefing-push-scheduler'

function ws(over: Partial<BriefingWorkspaceFacts> = {}): BriefingWorkspaceFacts {
	return {
		workspaceId: 'w1',
		workspaceName: 'Acme',
		waiting: 0,
		topHeadline: null,
		finished: 0,
		finishedAgentName: null,
		finishedObjectTitle: null,
		...over,
	}
}

describe('buildBriefingText', () => {
	it('returns null when there is nothing to say', () => {
		expect(buildBriefingText([])).toBeNull()
		expect(buildBriefingText([ws(), ws({ workspaceId: 'w2' })])).toBeNull()
	})

	it('names waiting items and the one agent that finished', () => {
		const t = buildBriefingText([
			ws({
				waiting: 2,
				finished: 1,
				finishedAgentName: 'Researcher',
				finishedObjectTitle: 'Market scan',
			}),
		])
		expect(t).toMatchObject({
			workspaceId: 'w1',
			title: '2 things need you',
			body: "Researcher finished 'Market scan'",
		})
	})

	it('uses singular wording and falls back to the top headline when nothing finished', () => {
		const t = buildBriefingText([ws({ waiting: 1, topHeadline: 'Approve the Q3 email draft' })])
		expect(t).toMatchObject({ title: '1 thing needs you', body: 'Approve the Q3 email draft' })
	})

	it('summarises several finished runs and works with nothing waiting', () => {
		const t = buildBriefingText([ws({ finished: 3 })])
		expect(t).toMatchObject({ title: '3 agent runs finished', body: '' })
		const one = buildBriefingText([
			ws({ finished: 1, finishedAgentName: 'Writer', finishedObjectTitle: null }),
		])
		expect(one?.title).toBe('Writer finished a task')
	})

	it('multi-workspace: anchors on the workspace with the most waiting and counts the rest', () => {
		const t = buildBriefingText([
			ws({ workspaceId: 'a', workspaceName: 'Alpha', waiting: 1 }),
			ws({ workspaceId: 'b', workspaceName: 'Beta', waiting: 4, finished: 2 }),
			ws({ workspaceId: 'c', workspaceName: 'Gamma', waiting: 0 }),
		])
		expect(t?.workspaceId).toBe('b')
		expect(t?.title).toBe('4 things need you')
		expect(t?.body).toBe('2 agent runs finished · in Beta · 1 more in other workspaces')
	})

	it('breaks ties on finished runs, then name, deterministically', () => {
		const t = buildBriefingText([
			ws({ workspaceId: 'a', workspaceName: 'Alpha', waiting: 2, finished: 1 }),
			ws({ workspaceId: 'b', workspaceName: 'Beta', waiting: 2, finished: 3 }),
		])
		expect(t?.workspaceId).toBe('b')
	})

	it('truncates long titles', () => {
		const t = buildBriefingText([
			ws({ finished: 1, finishedAgentName: 'R', finishedObjectTitle: 'x'.repeat(200) }),
		])
		expect(t?.title.length).toBeLessThan(100)
	})
})

describe('BriefingPushScheduler kill switch', () => {
	it('FEATURE_BRIEFING_PUSH=0 returns before touching the database', async () => {
		const db = new Proxy(
			{},
			{
				get: () => {
					throw new Error('db touched')
				},
			},
		) as unknown as Database
		const s = new BriefingPushScheduler(db, { FEATURE_BRIEFING_PUSH: '0' })
		await expect(s.tick(new Date())).resolves.toBe(0)
	})
})
