import type { Database } from '@maskin/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findChiefOfStaffId, track, shouldSkip } = vi.hoisted(() => ({
	findChiefOfStaffId: vi.fn(),
	track: vi.fn().mockResolvedValue(undefined),
	shouldSkip: vi.fn().mockReturnValue(false),
}))
vi.mock('../../lib/chief-of-staff', () => ({ findChiefOfStaffId }))
vi.mock('../../lib/analytics/integration-events', () => ({
	trackConnectChecklistStarted: track,
}))
vi.mock('../../lib/onboarding/chief-of-staff-kickoff', () => ({
	shouldSkipOnboardingKickoff: shouldSkip,
}))
vi.mock('../../services/session-lifecycle', () => ({ startSession: vi.fn() }))

import {
	CONNECT_CHECKLIST_SKILL,
	buildConnectChecklistPrompt,
	startConnectChecklistSession,
} from '../../services/connect-checklist'

// select().from().where().limit() resolves to the next queued row set: first the person, then
// the integration row.
function fakeDb(person: unknown[], integration: unknown[]): Database {
	const queue = [person, integration]
	const chain = {
		from: () => chain,
		where: () => chain,
		limit: async () => queue.shift() ?? [],
	}
	return { select: () => chain } as unknown as Database
}

const input = (db: Database) => ({
	db,
	workspaceId: 'ws-1',
	actorId: 'actor-1',
	integrationId: 'int-1',
	provider: 'posthog',
})

beforeEach(() => {
	findChiefOfStaffId.mockReset().mockResolvedValue('cos-1')
	track.mockClear()
	shouldSkip.mockReturnValue(false)
})

describe('startConnectChecklistSession', () => {
	it('starts the Chief of Staff once, naming the person, the tool and the access level', async () => {
		const start = vi.fn().mockResolvedValue({ sessionId: 's-1' })
		const db = fakeDb([{ name: 'Ada' }], [{ access: 'read_write' }])

		const res = await startConnectChecklistSession(input(db), { start })

		expect(res).toEqual({ started: true })
		expect(start).toHaveBeenCalledOnce()
		const arg = start.mock.calls[0]?.[0]
		expect(arg).toMatchObject({
			workspaceId: 'ws-1',
			actorId: 'cos-1',
			callerKind: 'internal',
			createdBy: 'actor-1',
			initiatedFromObjectId: null,
			await: 'none',
		})
		expect(arg.actionPrompt).toContain('Ada')
		expect(arg.actionPrompt).toContain('PostHog')
		expect(arg.actionPrompt).toContain('read and write')
		expect(arg.actionPrompt).toContain(CONNECT_CHECKLIST_SKILL)
	})

	it('records connect_checklist_started with provider and workspace only', async () => {
		const start = vi.fn().mockResolvedValue({ sessionId: 's-1' })
		await startConnectChecklistSession(input(fakeDb([{ name: 'Ada' }], [{ access: 'read' }])), {
			start,
		})
		expect(track).toHaveBeenCalledOnce()
		expect(track).toHaveBeenCalledWith({ provider: 'posthog', workspaceId: 'ws-1' })
	})

	it('says access is none yet for a connection that starts closed (second Gmail account)', async () => {
		const start = vi.fn().mockResolvedValue({ sessionId: 's-1' })
		await startConnectChecklistSession(
			{ ...input(fakeDb([{ name: 'Ada' }], [{ access: 'none' }])), provider: 'gmail' },
			{ start },
		)
		expect(start.mock.calls[0]?.[0].actionPrompt).toContain('none yet')
	})

	it('starts nothing and logs when the workspace has no Chief of Staff', async () => {
		findChiefOfStaffId.mockResolvedValue(null)
		const start = vi.fn()
		const res = await startConnectChecklistSession(input(fakeDb([], [])), { start })
		expect(res).toEqual({ started: false })
		expect(start).not.toHaveBeenCalled()
		expect(track).not.toHaveBeenCalled()
	})

	it('never throws and records no event when the session cannot start', async () => {
		const start = vi.fn().mockRejectedValue(new Error('no credentials'))
		const res = await startConnectChecklistSession(
			input(fakeDb([{ name: 'Ada' }], [{ access: 'read' }])),
			{ start },
		)
		expect(res).toEqual({ started: false })
		expect(track).not.toHaveBeenCalled()
	})

	it('starts nothing in an E2E stack', async () => {
		shouldSkip.mockReturnValue(true)
		const start = vi.fn()
		const res = await startConnectChecklistSession(input(fakeDb([], [])), { start })
		expect(res).toEqual({ started: false })
		expect(start).not.toHaveBeenCalled()
	})
})

describe('buildConnectChecklistPrompt', () => {
	it('falls back to the raw provider name for a provider the registry does not know', async () => {
		const start = vi.fn().mockResolvedValue({ sessionId: 's-1' })
		await startConnectChecklistSession(
			{ ...input(fakeDb([{ name: 'Ada' }], [{ access: 'read' }])), provider: 'not-a-provider' },
			{ start },
		)
		expect(start.mock.calls[0]?.[0].actionPrompt).toContain('not-a-provider')
	})

	it('words each access level', () => {
		const p = (access: 'read' | 'read_write' | 'none') =>
			buildConnectChecklistPrompt({ person: 'Ada', tool: 'Notion', access })
		expect(p('read')).toContain('Agent access to it: read.')
		expect(p('read_write')).toContain('read and write')
		expect(p('none')).toContain('none yet')
	})
})
