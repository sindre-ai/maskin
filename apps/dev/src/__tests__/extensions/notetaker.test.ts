import { randomUUID } from 'node:crypto'
import type { Database } from '@maskin/db'
import notetakerExtension from '@maskin/ext-notetaker/server'
import type { ModuleEnv, ModuleLifecycleContext } from '@maskin/module-sdk'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import type { AgentStorageManager } from '../../services/agent-storage'
import type { SessionManager } from '../../services/session-manager'
import { buildActor, buildTrigger, buildWorkspace } from '../factories'
import { createTestContext } from '../setup'

function buildCtx(): ModuleLifecycleContext {
	return { workspaceId: randomUUID(), actorId: randomUUID() }
}

/**
 * Wraps the mock db Proxy so we can observe calls to top-level operations
 * (insert/update/delete/select) and capture args passed to chained `.set()` — both
 * of which are awkward to observe directly on a Proxy-based mock.
 */
function instrument(db: Database) {
	const calls = {
		insert: 0,
		update: 0,
		delete: 0,
		select: 0,
	}
	const capturedUpdateSets: Record<string, unknown>[] = []

	const wrapped = new Proxy(db, {
		get(target, prop, receiver) {
			if (prop === 'insert') {
				calls.insert++
				return (t: unknown) => Reflect.get(target, prop, receiver)(t)
			}
			if (prop === 'update') {
				calls.update++
				return (t: unknown) => {
					const chain = Reflect.get(target, prop, receiver)(t) as Record<string, unknown>
					const originalSet = chain.set as (v: Record<string, unknown>) => unknown
					chain.set = (values: Record<string, unknown>) => {
						capturedUpdateSets.push(values)
						return originalSet.call(chain, values)
					}
					return chain
				}
			}
			if (prop === 'delete') {
				calls.delete++
				return (t: unknown) => Reflect.get(target, prop, receiver)(t)
			}
			if (prop === 'select' || prop === 'selectDistinct') {
				calls.select++
				return () => Reflect.get(target, prop, receiver)()
			}
			return Reflect.get(target, prop, receiver)
		},
	})

	return { db: wrapped, calls, capturedUpdateSets }
}

function buildEnv(db: ModuleEnv['db']): ModuleEnv {
	return {
		db,
		notifyBridge: {} as PgNotifyBridge,
		sessionManager: {} as SessionManager,
		agentStorage: {} as AgentStorageManager,
		storageProvider: {} as StorageProvider,
	}
}

describe('notetaker extension', () => {
	it('exposes onEnable/onDisable hooks and a meeting object type', () => {
		expect(notetakerExtension.id).toBe('notetaker')
		expect(notetakerExtension.onEnable).toBeTypeOf('function')
		expect(notetakerExtension.onDisable).toBeTypeOf('function')
		const meetingType = notetakerExtension.objectTypes.find((t) => t.type === 'meeting')
		expect(meetingType).toBeDefined()
	})

	describe('onEnable (fresh install — no existing ids)', () => {
		it('creates two agents and three triggers and persists ids to custom_extensions.notetaker.config', async () => {
			const ctx = buildCtx()
			const workspace = buildWorkspace({
				id: ctx.workspaceId,
				settings: { enabled_modules: ['work', 'notetaker'] },
			})
			const summarizerId = randomUUID()
			const dispatcherId = randomUUID()
			const mcTriggerId = randomUUID()
			const trTriggerId = randomUUID()
			const csTriggerId = randomUUID()

			const { db: rawDb, mockResults } = createTestContext()
			mockResults.selectQueue = [[workspace]]
			// Order matches onEnable: summarizer actor, member, dispatcher actor, member,
			// meeting.created trigger, transcript.attached trigger, calendar.sync trigger.
			mockResults.insertQueue = [
				[{ id: summarizerId }],
				[],
				[{ id: dispatcherId }],
				[],
				[{ id: mcTriggerId }],
				[{ id: trTriggerId }],
				[{ id: csTriggerId }],
			]
			const { db, calls, capturedUpdateSets } = instrument(rawDb)

			await notetakerExtension.onEnable?.(buildEnv(db), ctx)

			// 2 agents + 2 workspace_members + 3 triggers = 7 inserts
			expect(calls.insert).toBe(7)
			// Single update for the workspace settings merge.
			expect(calls.update).toBe(1)

			const settings = capturedUpdateSets[0].settings as Record<string, unknown>
			const custom = settings.custom_extensions as Record<
				string,
				{ config: Record<string, unknown> }
			>
			expect(custom.notetaker.config).toMatchObject({
				summarizerActorId: summarizerId,
				dispatcherActorId: dispatcherId,
				meetingCreatedTriggerId: mcTriggerId,
				transcriptReadyTriggerId: trTriggerId,
				calendarSyncTriggerId: csTriggerId,
				autoJoin: true,
				defaultLanguage: 'en',
				botName: 'Maskin Notetaker',
				syncIntervalMinutes: 10,
			})
		})
	})

	describe('onEnable (idempotent re-enable — all ids already stored)', () => {
		it('reuses existing agents and triggers without inserting new rows', async () => {
			const ctx = buildCtx()
			const ids = {
				summarizerActorId: randomUUID(),
				dispatcherActorId: randomUUID(),
				meetingCreatedTriggerId: randomUUID(),
				transcriptReadyTriggerId: randomUUID(),
				calendarSyncTriggerId: randomUUID(),
			}
			const workspace = buildWorkspace({
				id: ctx.workspaceId,
				settings: {
					enabled_modules: ['work', 'notetaker'],
					custom_extensions: {
						notetaker: {
							name: 'Notetaker',
							types: ['meeting'],
							enabled: true,
							config: { ...ids, autoJoin: true, defaultLanguage: 'en', syncIntervalMinutes: 10 },
						},
					},
				},
			})

			const { db: rawDb, mockResults } = createTestContext()
			// readConfig → workspace; then each ensure* selects its existing row.
			mockResults.selectQueue = [
				[workspace],
				[buildActor({ id: ids.summarizerActorId, type: 'agent' })],
				[buildActor({ id: ids.dispatcherActorId, type: 'agent' })],
				[buildTrigger({ id: ids.meetingCreatedTriggerId, workspaceId: ctx.workspaceId })],
				[buildTrigger({ id: ids.transcriptReadyTriggerId, workspaceId: ctx.workspaceId })],
				[buildTrigger({ id: ids.calendarSyncTriggerId, workspaceId: ctx.workspaceId })],
			]
			const { db, calls } = instrument(rawDb)

			await notetakerExtension.onEnable?.(buildEnv(db), ctx)

			// No inserts at all — every resource already existed.
			expect(calls.insert).toBe(0)
			// 3 trigger reconciliation updates + 1 workspace settings update = 4.
			expect(calls.update).toBe(4)
		})
	})

	describe('onDisable', () => {
		it('deletes stored agents and triggers and clears their ids from config', async () => {
			const ctx = buildCtx()
			const ids = {
				summarizerActorId: randomUUID(),
				dispatcherActorId: randomUUID(),
				meetingCreatedTriggerId: randomUUID(),
				transcriptReadyTriggerId: randomUUID(),
				calendarSyncTriggerId: randomUUID(),
			}
			const workspace = buildWorkspace({
				id: ctx.workspaceId,
				settings: {
					enabled_modules: ['work'],
					custom_extensions: {
						notetaker: {
							name: 'Notetaker',
							types: ['meeting'],
							enabled: true,
							config: { ...ids, autoJoin: true, defaultLanguage: 'en', syncIntervalMinutes: 10 },
						},
					},
				},
			})

			const { db: rawDb, mockResults } = createTestContext()
			mockResults.selectQueue = [[workspace]]
			const { db, calls, capturedUpdateSets } = instrument(rawDb)

			await notetakerExtension.onDisable?.(buildEnv(db), ctx)

			// 3 trigger deletes + 2 * (workspace_members + actors) = 7 deletes.
			expect(calls.delete).toBe(7)
			expect(calls.update).toBe(1)

			const settings = capturedUpdateSets[0].settings as Record<string, unknown>
			const custom = settings.custom_extensions as Record<
				string,
				{ config: Record<string, unknown> }
			>
			expect(custom.notetaker.config.summarizerActorId).toBeUndefined()
			expect(custom.notetaker.config.dispatcherActorId).toBeUndefined()
			expect(custom.notetaker.config.meetingCreatedTriggerId).toBeUndefined()
			expect(custom.notetaker.config.transcriptReadyTriggerId).toBeUndefined()
			expect(custom.notetaker.config.calendarSyncTriggerId).toBeUndefined()
		})
	})
})
