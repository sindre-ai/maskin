import { events, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureSessionLifecycle, settleSession } from '../../services/session-lifecycle'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertObject, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// The two terminal writers that never go through settleSession must still send
// the return: SessionManager.handleCompletion (local Docker) and
// SessionManager.markRemoteSessionComplete (remote hosts). Against real Postgres
// and the real SessionManager; only storage is stubbed.

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

function stubStorage(): StorageProvider {
	return {
		put: async () => {},
		get: async () => Buffer.from(''),
		list: async () => [],
		delete: async () => {},
		exists: async () => false,
		ensureBucket: async () => {},
	}
}

describe('Helper return from the terminal writers (integration)', () => {
	let manager: SessionManager
	let workspaceId: string
	let helperActorId: string
	let objectId: string
	let helperId: string

	beforeEach(async () => {
		manager = new SessionManager(db, stubStorage())
		configureSessionLifecycle({ db, sessionManager: manager })
		const human = getTestActorId()
		workspaceId = (await insertWorkspace(db, human, { enterpriseGranted: true })).id
		const mk = (name: string) =>
			insertActor(db, {
				type: 'agent',
				name,
				email: `${name.toLowerCase()}-${Math.random().toString(36).slice(2)}@integration.test`,
				apiKey: `ank_${name}_${Math.random().toString(36).slice(2)}`,
			})
		const [sender, helper] = await Promise.all([mk('Sender'), mk('Helper')])
		helperActorId = helper.id
		objectId = (await insertObject(db, workspaceId, human, { type: 'task', title: 't' })).id
		const senderSession = await insertSession(db, workspaceId, sender.id, sender.id, {
			status: 'completed',
			initiatedFromObjectId: objectId,
		})
		helperId = (
			await insertSession(db, workspaceId, helper.id, sender.id, {
				status: 'running',
				result: null,
				spawnedBySessionId: senderSession.id,
				initiatedFromObjectId: objectId,
			})
		).id
	})

	afterEach(async () => {
		// Fire-and-forget returns finish after the awaited call; let them land
		// before the next test's truncate.
		await new Promise((r) => setTimeout(r, 300))
		await manager.stop()
	})

	const returnTexts = async () =>
		(
			await db
				.select({ data: events.data })
				.from(events)
				.where(
					and(
						eq(events.entityId, objectId),
						eq(events.action, 'commented'),
						eq(events.actorId, helperActorId),
					),
				)
		).map((r) => (r.data as { content: string }).content)

	const waitForReturns = (n: number) =>
		vi.waitFor(async () => expect(await returnTexts()).toHaveLength(n), {
			timeout: 5_000,
			interval: 50,
		})

	it('markRemoteSessionComplete: a non-zero exit sends one failed return, a repeat report adds none', async () => {
		await manager.markRemoteSessionComplete(helperId, 1)
		await waitForReturns(1)
		await manager.markRemoteSessionComplete(helperId, 1)
		await new Promise((r) => setTimeout(r, 400))
		const texts = await returnTexts()
		expect(texts).toHaveLength(1)
		expect(texts[0]).toContain('Helper stopped with an error')
	})

	it('markRemoteSessionComplete: a clean exit sends a completed return', async () => {
		await manager.markRemoteSessionComplete(helperId, 0)
		await waitForReturns(1)
		expect((await returnTexts())[0]).toContain('finished the work you handed it')
	})

	it('markRemoteSessionComplete: stopSession’s provisional write sends nothing; the genuine report sends one stop return', async () => {
		await manager.markRemoteSessionComplete(helperId, null, { stoppedByUser: true })
		await new Promise((r) => setTimeout(r, 500))
		expect(await returnTexts()).toHaveLength(0)
		const [mid] = await db.select().from(sessions).where(eq(sessions.id, helperId))
		expect(mid.helperReturnedAt).toBeNull()

		await manager.markRemoteSessionComplete(helperId, 143)
		await waitForReturns(1)
		const texts = await returnTexts()
		expect(texts).toHaveLength(1)
		expect(texts[0]).toContain('A person stopped Helper')
		expect(texts[0]).not.toContain('retry')
	})

	it('handleCompletion: a non-zero exit sends one failed return', async () => {
		const handle = (
			manager as unknown as {
				handleCompletion: (id: string, container: string, exit: number | null) => Promise<void>
			}
		).handleCompletion.bind(manager)
		await handle(helperId, 'container-x', 1)
		await waitForReturns(1)
		const texts = await returnTexts()
		expect(texts).toHaveLength(1)
		expect(texts[0]).toContain('Helper stopped with an error')
	})

	it('a timeout settle then a late completion report still sends exactly one return, saying timeout', async () => {
		await settleSession(
			helperId,
			{ kind: 'timeout', classification: 'wall_timeout', source: 'timeout-watchdog' },
			{ db, stopSandbox: async () => 'local', pushAgentFiles: async () => 'ok' },
		)
		await waitForReturns(1)
		// The runtime exits after the watchdog stopped it and reports a clean exit.
		await manager.markRemoteSessionComplete(helperId, 0)
		await new Promise((r) => setTimeout(r, 400))
		const texts = await returnTexts()
		expect(texts).toHaveLength(1)
		expect(texts[0]).toContain('ran out of time')
	})
})
