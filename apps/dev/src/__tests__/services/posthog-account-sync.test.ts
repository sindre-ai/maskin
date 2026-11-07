import type { Database } from '@maskin/db'
import { workspaceMembers, workspaces } from '@maskin/db/schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { captureMock } = vi.hoisted(() => ({ captureMock: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: captureMock }))

const { PosthogAccountSync } = await import('../../services/posthog-account-sync')

const TEAM_WS = '11111111-1111-4111-8111-111111111111'
const CUSTOMER_WS = '22222222-2222-4222-8222-222222222222'
const PRIVATE_WS = '33333333-3333-4333-8333-333333333333'
const TEAMMATE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CUSTOMER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PRIVATE_PERSON = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const AGENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const created = new Date('2026-09-01T10:00:00Z')

const WORKSPACES = [
	{ id: TEAM_WS, createdAt: created, settings: {} },
	{ id: CUSTOMER_WS, createdAt: created, settings: { privacy: { share_usage: true } } },
	{ id: PRIVATE_WS, createdAt: created, settings: { privacy: { anonymize_workspace: true } } },
]
const MEMBERS = [
	{ workspaceId: TEAM_WS, actorId: TEAMMATE, role: 'owner', type: 'human', createdAt: created },
	{
		workspaceId: CUSTOMER_WS,
		actorId: TEAMMATE,
		role: 'member',
		type: 'human',
		createdAt: created,
	},
	{ workspaceId: CUSTOMER_WS, actorId: CUSTOMER, role: 'admin', type: 'human', createdAt: created },
	{ workspaceId: CUSTOMER_WS, actorId: AGENT, role: 'member', type: 'agent', createdAt: created },
	{
		workspaceId: PRIVATE_WS,
		actorId: PRIVATE_PERSON,
		role: 'owner',
		type: 'human',
		createdAt: created,
	},
]
const INTEGRATIONS = [{ workspaceId: CUSTOMER_WS, total: 2 }]

// Answers the three reads by the table they start from. A promise that also carries the
// query builder methods, so `await db.select().from(t).innerJoin().where().groupBy()` resolves.
function fakeDb(): Database {
	const rowsFor = (table: unknown) =>
		table === workspaces ? WORKSPACES : table === workspaceMembers ? MEMBERS : INTEGRATIONS
	const select = () => ({
		from: (table: unknown) => {
			const query: Promise<unknown> & Record<string, unknown> = Object.assign(
				Promise.resolve(rowsFor(table)),
				{} as Record<string, unknown>,
			)
			for (const method of ['innerJoin', 'where', 'groupBy']) query[method] = () => query
			return query
		},
	})
	return { select } as unknown as Database
}

type GroupProps = {
	workspace_id: string
	$group_type: string
	$group_key: string
	$group_set: Record<string, unknown>
}

function sentGroups(): GroupProps[] {
	return captureMock.mock.calls
		.filter((c) => c[0] === '$groupidentify')
		.map((c) => c[2] as GroupProps)
}

function sentPeople(): Record<string, Record<string, unknown>> {
	return Object.fromEntries(
		captureMock.mock.calls
			.filter((c) => c[0] === '$set')
			.map((c) => [c[1] as string, (c[2] as { $set: Record<string, unknown> }).$set]),
	)
}

describe('PosthogAccountSync', () => {
	beforeEach(() => {
		captureMock.mockClear()
		vi.stubEnv('POSTHOG_API_KEY', 'phc_test')
		vi.stubEnv('POSTHOG_TEAM_WORKSPACE_ID', TEAM_WS)
	})
	afterEach(() => vi.unstubAllEnvs())

	it('sends one group per workspace with counts, outside member and team flags', async () => {
		const summary = await new PosthogAccountSync(fakeDb()).syncAll()
		expect(summary.workspaces).toBe(3)

		const groups = Object.fromEntries(sentGroups().map((p) => [p.$group_key, p.$group_set]))
		expect(groups[CUSTOMER_WS]).toEqual({
			workspace_id: CUSTOMER_WS,
			created_at: created.toISOString(),
			member_count: 2,
			agent_count: 1,
			integrations_connected_count: 2,
			has_outside_member: true,
			is_team: false,
		})
		expect(groups[TEAM_WS]).toMatchObject({
			member_count: 1,
			integrations_connected_count: 0,
			has_outside_member: false,
			is_team: true,
		})
		// The group event names its workspace, so the capture honours that workspace's privacy settings.
		for (const p of sentGroups()) {
			expect(p.workspace_id).toBe(p.$group_key)
			expect(p.$group_type).toBe('workspace')
		}
	})

	it('leaves has_outside_member off when no team workspace is set', async () => {
		vi.stubEnv('POSTHOG_TEAM_WORKSPACE_ID', '')
		await new PosthogAccountSync(fakeDb()).syncAll()
		const p = sentGroups().find((x) => x.$group_key === CUSTOMER_WS) as GroupProps
		expect(p.$group_set).not.toHaveProperty('has_outside_member')
		expect(p.$group_set.is_team).toBe(false)
	})

	it('sends people with their strongest role, sign-up date and team flag, and no names', async () => {
		await new PosthogAccountSync(fakeDb()).syncAll()
		const people = sentPeople()
		expect(people[TEAMMATE]).toEqual({
			workspace_role: 'owner',
			is_team: true,
			signup_date: '2026-09-01',
		})
		expect(people[CUSTOMER]).toEqual({
			workspace_role: 'admin',
			is_team: false,
			signup_date: '2026-09-01',
		})
	})

	it('skips agents and people who belong to an anonymised workspace', async () => {
		const summary = await new PosthogAccountSync(fakeDb()).syncAll()
		const ids = Object.keys(sentPeople())
		expect(ids).not.toContain(AGENT)
		expect(ids).not.toContain(PRIVATE_PERSON)
		expect(summary.people).toBe(2)
	})

	it('runs once a day, in the 03:00 UTC hour', async () => {
		const sync = new PosthogAccountSync(fakeDb())
		expect(await sync.tick(new Date('2026-11-06T09:00:00Z'))).toBeNull()
		expect(await sync.tick(new Date('2026-11-06T03:10:00Z'))).not.toBeNull()
		expect(await sync.tick(new Date('2026-11-06T03:40:00Z'))).toBeNull()
		expect(await sync.tick(new Date('2026-11-07T03:10:00Z'))).not.toBeNull()
	})

	it('does nothing without a PostHog key', async () => {
		vi.stubEnv('POSTHOG_API_KEY', '')
		expect(await new PosthogAccountSync(fakeDb()).tick(new Date('2026-11-06T03:10:00Z'))).toBeNull()
		expect(captureMock).not.toHaveBeenCalled()
	})

	it('tries again the same day when a run fails', async () => {
		const failing = { select: () => ({ from: () => Promise.reject(new Error('db down')) }) }
		const sync = new PosthogAccountSync(failing as unknown as Database)
		expect(await sync.tick(new Date('2026-11-06T03:10:00Z'))).toBeNull()
		const ok = new PosthogAccountSync(fakeDb())
		expect(await ok.tick(new Date('2026-11-06T03:50:00Z'))).not.toBeNull()
	})
})
