import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PackageVersionPusher, rewriteWiring } from '../../services/package-version-pusher'
import { createTestContext } from '../setup'

describe('rewriteWiring', () => {
	it('returns the snapshot unchanged when the map is empty', () => {
		const snap = { a: 'src-1', nested: { b: 'src-2' } }
		const out = rewriteWiring(snap, new Map())
		expect(out).toEqual(snap)
	})

	it('rewrites top-level string values whose value is a known source id', () => {
		const map = new Map([['src-1', 'local-1']])
		const out = rewriteWiring({ targetActorId: 'src-1', name: 'unchanged' }, map)
		expect(out).toEqual({ targetActorId: 'local-1', name: 'unchanged' })
	})

	it('rewrites recursively through nested objects and arrays', () => {
		const map = new Map([
			['src-1', 'local-1'],
			['src-2', 'local-2'],
		])
		const snap = {
			config: { targets: ['src-1', 'unrelated'], owner: 'src-2' },
			pairs: [{ id: 'src-1' }, { id: 'src-2' }],
		}
		const out = rewriteWiring(snap, map)
		expect(out).toEqual({
			config: { targets: ['local-1', 'unrelated'], owner: 'local-2' },
			pairs: [{ id: 'local-1' }, { id: 'local-2' }],
		})
	})

	it('leaves non-matching strings, numbers, booleans, and nulls alone', () => {
		const map = new Map([['src-1', 'local-1']])
		const snap = { a: 'no-match', b: 42, c: true, d: null }
		expect(rewriteWiring(snap, map)).toEqual(snap)
	})
})

describe('PackageVersionPusher', () => {
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

		const pusher = new PackageVersionPusher(db, 60_000)
		await pusher.tick()

		expect(calls.inserts).toEqual([])
		expect(calls.updates).toEqual([])
	})

	it('inserts a deduped notification for a forked install with a version mismatch', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [
			// tick(): pending installs join → one forked install at v1 vs catalog v2
			[
				{
					install: {
						id: 'install-1',
						workspaceId: 'ws-1',
						sourcePackageId: 'pkg-1',
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
			[{ id: 'sindre-actor' }],
		]

		const pusher = new PackageVersionPusher(db, 60_000)
		await pusher.tick()

		expect(calls.inserts).toHaveLength(1)
		const inserted = calls.inserts[0] as Record<string, unknown>
		expect(inserted.type).toBe('package_update_available')
		expect(inserted.workspaceId).toBe('ws-1')
		expect(inserted.status).toBe('pending')
		expect(inserted.sourceActorId).toBe('sindre-actor')
		expect(inserted.metadata).toMatchObject({
			installed_package_id: 'install-1',
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
						sourcePackageId: 'pkg-1',
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

		const pusher = new PackageVersionPusher(db, 60_000)
		await pusher.tick()

		expect(calls.inserts).toEqual([])
	})

	it('bumps installed_version on a locked install with an empty catalog', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [
			// tick(): pending installs join — one locked install at v1 vs catalog v2
			[
				{
					install: {
						id: 'install-2',
						workspaceId: 'ws-1',
						sourcePackageId: 'pkg-1',
						installedVersion: '1.0.0',
						isLocked: true,
						forkedAt: null,
						installedAt: new Date('2026-05-01'),
						updatedAt: new Date('2026-05-01'),
					},
					targetVersion: '2.0.0',
				},
			],
			// pushLockedInstall(): catalog items for the package — empty
			[],
			// loadInstalledRows(): actor rows
			[],
			// loadInstalledRows(): trigger rows
			[],
			// loadInstalledRows(): workspace_skill rows
			[],
			// loadInstalledRows(): integration rows
			[],
		]

		const pusher = new PackageVersionPusher(db, 60_000)
		await pusher.tick()

		// One update on installed_packages bumping the version.
		expect(calls.updates).toHaveLength(1)
		const update = calls.updates[0] as Record<string, unknown>
		expect(update.installedVersion).toBe('2.0.0')
	})

	it('adds a new catalog item to a locked install: actor gets a fresh apiKey + workspace_members binding, trigger gets a resolved createdBy and rewritten target', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [
			// tick(): pending installs join — one locked install at v1 vs catalog v2
			[
				{
					install: {
						id: 'install-1',
						workspaceId: 'ws-1',
						sourcePackageId: 'pkg-1',
						installedVersion: '1.0.0',
						isLocked: true,
						forkedAt: null,
						installedAt: new Date('2026-05-01'),
						updatedAt: new Date('2026-05-01'),
					},
					targetVersion: '2.0.0',
				},
			],
			// pushLockedInstall(): catalog items — a brand-new actor + trigger the
			// install doesn't have yet. The trigger targets the actor by source id.
			[
				{
					id: 'item-actor',
					sourceItemId: 'src-actor',
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
					sourceItemId: 'src-trigger',
					itemType: 'trigger',
					itemSnapshot: {
						name: 'Daily',
						type: 'cron',
						config: { expression: '0 9 * * *' },
						action_prompt: 'Run.',
						target_actor_id: 'src-actor',
					},
				},
			],
			// loadInstalledRows(): nothing installed yet — both items are adds.
			[],
			[],
			[],
			[],
			// resolveWorkspaceActor(): a system actor is a member of the workspace.
			[{ id: 'sindre-actor' }],
		]
		// Inserts fire in order: actor, workspace_members (binds the actor), trigger.
		mockResults.insertQueue = [[{ id: 'new-actor' }], [], [{ id: 'new-trigger' }]]

		const pusher = new PackageVersionPusher(db, 60_000)
		await pusher.tick()

		// #1 — actor minted a fresh, cryptographically-secure apiKey; the
		// publisher's snapshot apiKey was NOT honored (no auth leak / index collision).
		const actorInsert = calls.inserts[0] as Record<string, unknown>
		expect(actorInsert.apiKey).toMatch(/^ank_/)
		expect(actorInsert.apiKey).not.toBe('ank_publisherleak')
		expect((actorInsert.metadata as Record<string, unknown>).installed_package_id).toBe('install-1')

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
		expect(triggerInsert.createdBy).toBe('sindre-actor')
		expect(triggerInsert.targetActorId).toBe('new-actor')

		// The install row's version is bumped on success.
		const update = calls.updates[0] as Record<string, unknown>
		expect(update.installedVersion).toBe('2.0.0')
	})

	it('start() does not blow up and stop() clears timers', async () => {
		const { db } = createTestContext()
		const pusher = new PackageVersionPusher(db, 60_000)
		pusher.start()
		// idempotent: second start is a no-op
		pusher.start()
		pusher.stop()
	})
})
