import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rewriteWiring } from '../../services/loop-provisioning'
import { LoopVersionPusher } from '../../services/loop-version-pusher'
import { createMockAgentStorage, createTestContext } from '../setup'

// UUID-format IDs used across rewriteWiring tests.
const SRC_1 = '11111111-1111-4111-a111-111111111111'
const SRC_2 = '22222222-2222-4222-a222-222222222222'
const LOCAL_1 = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const LOCAL_2 = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'

describe('rewriteWiring', () => {
	it('returns the snapshot unchanged when the map is empty', () => {
		const snap = { a: SRC_1, nested: { b: SRC_2 } }
		const out = rewriteWiring(snap, new Map())
		expect(out).toEqual(snap)
	})

	it('rewrites top-level string values whose value is a known source id', () => {
		const map = new Map([[SRC_1, LOCAL_1]])
		const out = rewriteWiring({ targetActorId: SRC_1, name: 'unchanged' }, map)
		expect(out).toEqual({ targetActorId: LOCAL_1, name: 'unchanged' })
	})

	it('rewrites recursively through nested objects and arrays', () => {
		const map = new Map([
			[SRC_1, LOCAL_1],
			[SRC_2, LOCAL_2],
		])
		const snap = {
			config: { targets: [SRC_1, 'unrelated'], owner: SRC_2 },
			pairs: [{ id: SRC_1 }, { id: SRC_2 }],
		}
		const out = rewriteWiring(snap, map)
		expect(out).toEqual({
			config: { targets: [LOCAL_1, 'unrelated'], owner: LOCAL_2 },
			pairs: [{ id: LOCAL_1 }, { id: LOCAL_2 }],
		})
	})

	it('leaves non-matching UUIDs, numbers, booleans, and nulls alone', () => {
		const map = new Map([[SRC_1, LOCAL_1]])
		const snap = { a: SRC_2, b: 42, c: true, d: null }
		expect(rewriteWiring(snap, map)).toEqual(snap)
	})

	it('does not rewrite non-UUID strings even if they appear in the map', () => {
		const map = new Map([['some-label', 'other-label']])
		const snap = { actionPrompt: 'some-label', targetActorId: SRC_1 }
		expect(rewriteWiring(snap, map)).toEqual(snap)
	})
})

describe('LoopVersionPusher', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-06-12T00:00:00Z'))
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it('does nothing when no installs are out of date', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.select = []

		const pusher = new LoopVersionPusher(db, createMockAgentStorage(), 60_000)
		await pusher.tick()

		expect(calls.inserts).toEqual([])
		expect(calls.updates).toEqual([])
	})

	it('inserts a deduped notification for a forked install with a version mismatch', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [
			// tick(): pending installs join → one forked install at v1 vs marketplace v2
			[
				{
					install: {
						id: 'install-1',
						workspaceId: 'ws-1',
						sourceLoopId: 'loop-1',
						objectId: null,
						installedVersion: '1.0.0',
						isLocked: false,
						forkedAt: new Date('2026-06-01'),
						installedAt: new Date('2026-05-01'),
						updatedAt: new Date('2026-06-01'),
					},
					targetVersion: '1.1.0',
				},
			],
			// notifyForkedInstall(): no existing pending notification
			[],
			// resolveNotificationSource(): a system actor in the workspace
			[{ id: 'system-actor' }],
		]

		const pusher = new LoopVersionPusher(db, createMockAgentStorage(), 60_000)
		await pusher.tick()

		expect(calls.inserts).toHaveLength(1)
		const inserted = calls.inserts[0] as Record<string, unknown>
		expect(inserted.type).toBe('loop_update_available')
		expect(inserted.workspaceId).toBe('ws-1')
		expect(inserted.status).toBe('pending')
		expect(inserted.sourceActorId).toBe('system-actor')
		expect(inserted.metadata).toMatchObject({
			installed_loop_id: 'install-1',
			from_version: '1.0.0',
			to_version: '1.1.0',
		})
	})

	it('skips the notification when one for the same target version already exists', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [
			[
				{
					install: {
						id: 'install-1',
						workspaceId: 'ws-1',
						sourceLoopId: 'loop-1',
						objectId: null,
						installedVersion: '1.0.0',
						isLocked: false,
						forkedAt: new Date('2026-06-01'),
						installedAt: new Date('2026-05-01'),
						updatedAt: new Date('2026-06-01'),
					},
					targetVersion: '1.1.0',
				},
			],
			// notifyForkedInstall(): an existing pending notification matches
			[{ id: 'noti-existing' }],
		]

		const pusher = new LoopVersionPusher(db, createMockAgentStorage(), 60_000)
		await pusher.tick()

		expect(calls.inserts).toEqual([])
	})

	it('bumps installed_version on a locked install with an empty loop and audits the push', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [
			// tick(): pending installs join — one locked install at v1 vs marketplace v2
			[
				{
					install: {
						id: 'install-2',
						workspaceId: 'ws-1',
						sourceLoopId: 'loop-1',
						objectId: null,
						installedVersion: '1.0.0',
						isLocked: true,
						forkedAt: null,
						installedAt: new Date('2026-05-01'),
						updatedAt: new Date('2026-05-01'),
					},
					targetVersion: '2.0.0',
				},
			],
			// pushLockedInstall(): marketplace items for the loop — empty
			[],
			// loadInstalledRows(): actor rows
			[],
			// loadInstalledRows(): trigger rows
			[],
			// loadInstalledRows(): workspace_skill rows
			[],
			// loadInstalledRows(): integration rows
			[],
			// resolveWorkspaceActor(): a system actor is a member of the workspace —
			// resolved unconditionally now, since the audit event always needs an actorId.
			[{ id: 'system-actor' }],
		]

		const pusher = new LoopVersionPusher(db, createMockAgentStorage(), 60_000)
		await pusher.tick()

		// One update on installed_loops bumping the version.
		expect(calls.updates).toHaveLength(1)
		const update = calls.updates[0] as Record<string, unknown>
		expect(update.installedVersion).toBe('2.0.0')

		// Even an update-only (no adds/removes) push writes an audit event.
		expect(calls.inserts).toHaveLength(1)
		const eventInsert = calls.inserts[0] as Record<string, unknown>
		expect(eventInsert).toMatchObject({
			workspaceId: 'ws-1',
			actorId: 'system-actor',
			action: 'updated',
			entityType: 'installed_loop',
			entityId: 'install-2',
		})
		expect(eventInsert.data).toMatchObject({
			source_loop_id: 'loop-1',
			from_version: '1.0.0',
			to_version: '2.0.0',
			items: { adds: 0, updates: 0, removes: 0 },
		})
	})

	it('adds a new marketplace item to a locked install: actor gets a fresh apiKey + workspace_members binding, trigger gets a resolved createdBy and rewritten target', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [
			// tick(): pending installs join — one locked install at v1 vs marketplace v2
			[
				{
					install: {
						id: 'install-1',
						workspaceId: 'ws-1',
						sourceLoopId: 'loop-1',
						objectId: null,
						installedVersion: '1.0.0',
						isLocked: true,
						forkedAt: null,
						installedAt: new Date('2026-05-01'),
						updatedAt: new Date('2026-05-01'),
					},
					targetVersion: '2.0.0',
				},
			],
			// pushLockedInstall(): marketplace items — a brand-new actor + trigger the
			// install doesn't have yet. The trigger targets the actor by source id.
			[
				{
					id: 'item-actor',
					sourceItemId: 'cccccccc-cccc-4ccc-accc-cccccccccccc',
					itemType: 'actor',
					// Snapshot carries a publisher apiKey — must be ignored, not copied.
					itemSnapshot: {
						name: 'Researcher',
						type: 'agent',
						systemPrompt: 'Listen.',
						apiKey: 'ank_publisherleak',
					},
				},
				{
					id: 'item-trigger',
					sourceItemId: 'dddddddd-dddd-4ddd-addd-dddddddddddd',
					itemType: 'trigger',
					itemSnapshot: {
						name: 'Daily',
						type: 'cron',
						config: { expression: '0 9 * * *' },
						action_prompt: 'Run.',
						// Points at the source actor UUID — rewriteWiring swaps it for the
						// local actor id minted during this push.
						target_actor_id: 'cccccccc-cccc-4ccc-accc-cccccccccccc',
					},
				},
			],
			// loadInstalledRows(): nothing installed yet — both items are adds.
			[],
			[],
			[],
			[],
			// resolveWorkspaceActor(): a system actor is a member of the workspace.
			[{ id: 'system-actor' }],
			// Actor claim pre-check: nothing installed yet — miss, the INSERT claims.
			[],
		]
		// Inserts fire in order: actor, workspace_members (binds the actor), trigger,
		// then the audit event.
		mockResults.insertQueue = [[{ id: 'new-actor' }], [], [{ id: 'new-trigger' }], []]

		const pusher = new LoopVersionPusher(db, createMockAgentStorage(), 60_000)
		await pusher.tick()

		// #1 — actor minted a fresh, cryptographically-secure apiKey; the
		// publisher's snapshot apiKey was NOT honored (no auth leak / index collision).
		const actorInsert = calls.inserts[0] as Record<string, unknown>
		expect(actorInsert.apiKey).toMatch(/^ank_/)
		expect(actorInsert.apiKey).not.toBe('ank_publisherleak')
		expect((actorInsert.metadata as Record<string, unknown>).installed_loop_id).toBe('install-1')

		// #2 — the freshly-minted actor is bound to the workspace as a member,
		// mirroring the install endpoint. Without it the agent is orphaned.
		const memberInsert = calls.inserts[1] as Record<string, unknown>
		expect(memberInsert).toMatchObject({
			workspaceId: 'ws-1',
			actorId: 'new-actor',
			role: 'member',
		})

		// #1 — trigger gets a valid resolved createdBy (NOT the empty string that
		// would 've thrown an FK violation) and its target_actor_id is rewritten
		// from the source id to the freshly-minted local actor id.
		const triggerInsert = calls.inserts[2] as Record<string, unknown>
		expect(triggerInsert.createdBy).toBe('system-actor')
		expect(triggerInsert.targetActorId).toBe('new-actor')

		// The install row's version is bumped on success.
		const update = calls.updates[0] as Record<string, unknown>
		expect(update.installedVersion).toBe('2.0.0')

		// The push is audited with the add count for both new items.
		const eventInsert = calls.inserts[3] as Record<string, unknown>
		expect(eventInsert).toMatchObject({
			workspaceId: 'ws-1',
			actorId: 'system-actor',
			action: 'updated',
			entityType: 'installed_loop',
			entityId: 'install-1',
		})
		expect(eventInsert.data).toMatchObject({ items: { adds: 2, updates: 0, removes: 0 } })
	})

	it('start() does not blow up and stop() clears timers', async () => {
		const { db } = createTestContext()
		const pusher = new LoopVersionPusher(db, createMockAgentStorage(), 60_000)
		pusher.start()
		// idempotent: second start is a no-op
		pusher.start()
		pusher.stop()
	})
})
