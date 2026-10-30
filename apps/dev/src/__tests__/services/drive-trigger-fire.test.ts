import { EventEmitter } from 'node:events'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DRIVE_FILE_ENTITY } from '../../lib/integrations/providers/google-drive/fan-out'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import { TriggerRunner } from '../../services/trigger-runner'
import { buildTrigger } from '../factories'
import { createMockSessionManager, createTestContext } from '../setup'

// S11: a trigger configured on drive.file.created fires on the signal the Drive
// fan-out emits. The event below has exactly the entity type, action and data
// payload fan-out.ts writes; the runner is the existing trigger engine.

vi.mock('../../services/trigger-event-queue', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../services/trigger-event-queue')>()),
	findDueTriggerIds: vi.fn().mockResolvedValue([]),
	findDueWorkspaceIds: vi.fn().mockResolvedValue([]),
	sweepQueueRetention: vi.fn().mockResolvedValue(undefined),
}))

// startSession() checks that the agent is a member of the workspace. This test scripts the mock
// DB's selects one by one, so the check is stubbed; it is covered in lib/workspace-scope.test.ts.
vi.mock('../../lib/workspace-scope', () => ({
	assertInWorkspace: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

describe('Drive signal -> trigger engine (S11)', () => {
	let runner: TriggerRunner
	let bridge: EventEmitter & PgNotifyBridge
	let sessionManager: ReturnType<typeof createMockSessionManager>
	let mockResults: Record<string, unknown>

	// What runDriveFanOut writes for a created file in watched folder F1. The
	// entity_id is the Drive integration row's id.
	const signalData = {
		fileId: 'file-1',
		folderId: 'F1',
		eventType: 'created',
		changeTime: '2026-10-12T10:00:00.000Z',
		name: 'brief.pdf',
		mimeType: 'application/pdf',
	}
	const driveEvent: PgEvent = {
		workspace_id: 'ws-1',
		entity_type: DRIVE_FILE_ENTITY,
		entity_id: 'a4f1c9d2-3b58-4e07-9c26-8f5d0a7b1e43',
		action: 'created',
		actor_id: 'actor-1',
		event_id: 'evt-1',
	}

	beforeEach(async () => {
		vi.useFakeTimers()
		bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
		sessionManager = createMockSessionManager()
		const ctx = createTestContext()
		mockResults = ctx.mockResults
		configureSessionLifecycle({ db: ctx.db, sessionManager })
		runner = new TriggerRunner(ctx.db, bridge, sessionManager)
		;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: 'session-1',
		})
		mockResults.selectQueue = [[], []] // cron + reminder triggers
		await runner.start()
	})

	afterEach(async () => {
		await runner.stop()
		vi.useRealTimers()
	})

	it('fires a trigger on google_drive.file created and hands the file to the action prompt', async () => {
		const trigger = buildTrigger({
			workspaceId: 'ws-1',
			type: 'event',
			config: { entity_type: DRIVE_FILE_ENTITY, action: 'created', filter: { folderId: 'F1' } },
			actionPrompt: 'Summarise the new file',
		})
		mockResults.selectQueue = [[trigger], [{ data: signalData }]]
		mockResults.insert = [{ triggerId: 't1' }]

		bridge.emit('event', driveEvent)
		await vi.advanceTimersByTimeAsync(0)

		expect(sessionManager.createSession).toHaveBeenCalledOnce()
		const [, opts] = (sessionManager.createSession as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(opts.actionPrompt).toContain('file-1')
		expect(opts.actionPrompt).toContain('F1')
	})

	it('does not fire when the trigger is pinned to a different watched folder', async () => {
		const trigger = buildTrigger({
			workspaceId: 'ws-1',
			type: 'event',
			config: { entity_type: DRIVE_FILE_ENTITY, action: 'created', filter: { folderId: 'F2' } },
		})
		mockResults.selectQueue = [[trigger], [{ data: signalData }]]

		bridge.emit('event', driveEvent)
		await vi.advanceTimersByTimeAsync(0)

		expect(sessionManager.createSession).not.toHaveBeenCalled()
	})

	it('does not fire a created trigger on an updated signal', async () => {
		const trigger = buildTrigger({
			workspaceId: 'ws-1',
			type: 'event',
			config: { entity_type: DRIVE_FILE_ENTITY, action: 'created' },
		})
		mockResults.select = [trigger]

		bridge.emit('event', { ...driveEvent, action: 'updated' } satisfies PgEvent)
		await vi.advanceTimersByTimeAsync(0)

		expect(sessionManager.createSession).not.toHaveBeenCalled()
	})
})
